import { test, expect } from "bun:test";
import { Hono } from "hono";
import { FakeVerifier, DevHeaderVerifier, ChainVerifier, checkDomain } from "./oidc.ts";
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

test("loginConfigured: true iff google id+secret+session set (independent of dev-auth)", () => {
  expect(loginConfigured({ googleClientId: "", googleClientSecret: "", sessionSecret: "" })).toBe(false);
  expect(loginConfigured({ googleClientId: "id", googleClientSecret: "sec", sessionSecret: "s" })).toBe(true);
  expect(loginConfigured({ googleClientId: "id", googleClientSecret: "", sessionSecret: "s" })).toBe(false);
  expect(loginConfigured({ googleClientId: "id", googleClientSecret: "sec", sessionSecret: "" })).toBe(false);
});

test("checkDomain enforces the allowlist", () => {
  expect(checkDomain("x@gmail.com", undefined, [])).toBe(true);
  expect(checkDomain("x@example.com", "example.com", ["example.com"])).toBe(true);
  expect(checkDomain("x@gmail.com", "gmail.com", ["example.com"])).toBe(false);
  expect(checkDomain("x@example.com", undefined, ["example.com"])).toBe(true);
  expect(checkDomain("x@evil.com", undefined, ["example.com", "example.org"])).toBe(false);
});
