import { test, expect } from "bun:test";
import { Hono } from "hono";
import { FakeVerifier, DevHeaderVerifier, checkDomain } from "./oidc.ts";
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

test("checkDomain enforces the allowlist", () => {
  expect(checkDomain("x@gmail.com", undefined, [])).toBe(true);
  expect(checkDomain("x@example.com", "example.com", ["example.com"])).toBe(true);
  expect(checkDomain("x@gmail.com", "gmail.com", ["example.com"])).toBe(false);
  expect(checkDomain("x@example.com", undefined, ["example.com"])).toBe(true);
  expect(checkDomain("x@evil.com", undefined, ["example.com", "example.org"])).toBe(false);
});
