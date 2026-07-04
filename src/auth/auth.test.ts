import { test, expect } from "bun:test";
import { Hono } from "hono";
import { FakeVerifier, DevHeaderVerifier, ChainVerifier, checkDomain, checkGroup, mapClaims } from "./oidc.ts";
import { SessionVerifier, signSession } from "./session-token.ts";
import { loginConfigured } from "../api/auth-routes.ts";
import { authMiddleware, type AuthEnv } from "./middleware.ts";

function appWith(v: any) {
  const app = new Hono<AuthEnv>();
  app.use("*", authMiddleware(v));
  app.get("/me", (c) => c.json(c.get("identity")));
  return app;
}

test("missing token -> 401", async () => {
  const res = await appWith(new FakeVerifier({})).request("/me");
  expect(res.status).toBe(401);
});

test("valid token -> identity injected", async () => {
  const v = new FakeVerifier({ "tok-alice": { sub: "alice", email: "alice@example.com" } });
  const res = await appWith(v).request("/me", { headers: { authorization: "Bearer tok-alice" } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).email).toBe("alice@example.com");
});

test("dev header verifier parses sub:email", async () => {
  const v = new DevHeaderVerifier();
  expect(await v.verify("alice:alice@example.com")).toEqual({ sub: "alice", email: "alice@example.com" });
  expect(await v.verify("nosep")).toBeNull();
});

test("ChainVerifier: session token wins, dev token falls through, garbage is null", async () => {
  const secret = "test-secret-please-rotate-1234567890";
  const session = await signSession(secret, { sub: "a@example.com", email: "a@example.com" });
  const chain = new ChainVerifier([new SessionVerifier(secret), new DevHeaderVerifier()]);
  expect((await chain.verify(session))?.email).toBe("a@example.com"); // real session JWT
  expect((await chain.verify("bob:bob@example.com"))?.email).toBe("bob@example.com"); // dev fallback
  expect(await chain.verify("no-colon-not-a-jwt")).toBeNull();
});

test("loginConfigured: true iff oidc id+secret+session set (independent of dev-auth)", () => {
  expect(loginConfigured({ oidcClientId: "", oidcClientSecret: "", sessionSecret: "" })).toBe(false);
  expect(loginConfigured({ oidcClientId: "id", oidcClientSecret: "sec", sessionSecret: "s" })).toBe(true);
  expect(loginConfigured({ oidcClientId: "id", oidcClientSecret: "", sessionSecret: "s" })).toBe(false);
  expect(loginConfigured({ oidcClientId: "id", oidcClientSecret: "sec", sessionSecret: "" })).toBe(false);
});

test("checkDomain enforces the allowlist", () => {
  expect(checkDomain("x@gmail.com", undefined, [])).toBe(true);
  expect(checkDomain("x@example.com", "example.com", ["example.com"])).toBe(true);
  expect(checkDomain("x@gmail.com", "gmail.com", ["example.com"])).toBe(false);
  expect(checkDomain("x@example.com", undefined, ["example.com"])).toBe(true);
  expect(checkDomain("x@evil.com", undefined, ["example.com", "example.org"])).toBe(false);
});

// --- (J2) group gate ---------------------------------------------------------------------------

test("checkGroup handles array claims and space-joined string claims", () => {
  expect(checkGroup(["eng", "ops"], "ops")).toBe(true); // array (Keycloak/Authentik/Entra)
  expect(checkGroup(["eng"], "ops")).toBe(false);
  expect(checkGroup("eng ops sre", "ops")).toBe(true); // space-joined string (some Okta setups)
  expect(checkGroup("eng", "ops")).toBe(false);
  expect(checkGroup(undefined, "ops")).toBe(false); // missing claim
  expect(checkGroup(null, "ops")).toBe(false);
  expect(checkGroup([123, "ops"], "ops")).toBe(true); // non-string array members coerced
});

// --- (J2) claim mapping ------------------------------------------------------------------------

const BASE_OPTS = { emailClaim: "email", nameClaim: "name", allowedDomains: [] as string[], allowedEmails: [] as string[], isGoogle: false };

test("mapClaims maps the configured email + name claims", () => {
  const r = mapClaims({ email: "a@ex.com", name: "Alice" }, BASE_OPTS);
  expect(r).toEqual({ ok: true, email: "a@ex.com", name: "Alice" });
});

test("mapClaims reads NON-default claim names from config (e.g. Entra 'preferred_username')", () => {
  const r = mapClaims(
    { preferred_username: "b@ex.com", displayName: "Bob" },
    { ...BASE_OPTS, emailClaim: "preferred_username", nameClaim: "displayName" },
  );
  expect(r).toEqual({ ok: true, email: "b@ex.com", name: "Bob" });
});

test("mapClaims rejects a missing/blank email claim with a clear error", () => {
  const r = mapClaims({ name: "Nobody" }, BASE_OPTS);
  expect(r.ok).toBe(false);
  expect((r as { error: string }).error).toContain("email");
});

test("mapClaims rejects email_verified===false but ALLOWS an absent email_verified", () => {
  expect(mapClaims({ email: "a@ex.com", email_verified: false }, BASE_OPTS).ok).toBe(false);
  expect(mapClaims({ email: "a@ex.com", email_verified: true }, BASE_OPTS).ok).toBe(true);
  expect(mapClaims({ email: "a@ex.com" }, BASE_OPTS).ok).toBe(true); // absent → allowed (non-Google IdPs omit it)
});

test("mapClaims domain gate: Google trusts `hd`, generic issuers use the email suffix", () => {
  // Google: hd wins over the email domain.
  expect(mapClaims({ email: "a@ex.com", hd: "corp.com" }, { ...BASE_OPTS, allowedDomains: ["corp.com"], isGoogle: true }).ok).toBe(true);
  expect(mapClaims({ email: "a@corp.com", hd: "corp.com" }, { ...BASE_OPTS, allowedDomains: ["ex.com"], isGoogle: true }).ok).toBe(false);
  // Non-Google: `hd` is ignored entirely; the email domain is what's gated.
  expect(mapClaims({ email: "a@corp.com", hd: "corp.com" }, { ...BASE_OPTS, allowedDomains: ["corp.com"], isGoogle: false }).ok).toBe(true);
  expect(mapClaims({ email: "a@evil.com", hd: "corp.com" }, { ...BASE_OPTS, allowedDomains: ["corp.com"], isGoogle: false }).ok).toBe(false);
});

test("mapClaims applies the per-email allowlist on top of the domain gate", () => {
  const opts = { ...BASE_OPTS, allowedEmails: ["a@ex.com"] };
  expect(mapClaims({ email: "a@ex.com" }, opts).ok).toBe(true);
  expect(mapClaims({ email: "b@ex.com" }, opts).ok).toBe(false);
});

test("mapClaims group gate: array/string membership, missing → reject, unset → no gate", () => {
  const gated = { ...BASE_OPTS, groupsClaim: "groups", requiredGroup: "drop-admins" };
  expect(mapClaims({ email: "a@ex.com", groups: ["drop-admins", "x"] }, gated).ok).toBe(true);
  expect(mapClaims({ email: "a@ex.com", groups: "x drop-admins" }, gated).ok).toBe(true);
  expect(mapClaims({ email: "a@ex.com", groups: ["x"] }, gated).ok).toBe(false);
  expect(mapClaims({ email: "a@ex.com" }, gated).ok).toBe(false); // group claim absent → rejected
  expect(mapClaims({ email: "a@ex.com" }, BASE_OPTS).ok).toBe(true); // no requiredGroup → no gate
});
