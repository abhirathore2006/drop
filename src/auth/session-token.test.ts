import { test, expect } from "bun:test";
import { signSession, SessionVerifier } from "./session-token.ts";

test("session token round trip", async () => {
  const secret = "test-secret-please-rotate";
  const tok = await signSession(secret, { sub: "alice@example.com", email: "alice@example.com" });
  const id = await new SessionVerifier(secret).verify(tok);
  expect(id?.sub).toBe("alice@example.com");
  expect(id?.email).toBe("alice@example.com");
});

test("rejects wrong secret and garbage", async () => {
  const tok = await signSession("s1", { sub: "a@b.com", email: "a@b.com" });
  expect(await new SessionVerifier("s2").verify(tok)).toBeNull();
  expect(await new SessionVerifier("s1").verify("not.a.jwt")).toBeNull();
});
