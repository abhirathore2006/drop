import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Identity, Verifier } from "./types.ts";

export type AuthEnv = { Variables: { identity: Identity } };

export const SESSION_COOKIE = "drop_session";

/** Verifies the bearer token (or the dashboard session cookie) and injects the Identity. */
export function authMiddleware(v: Verifier) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const m = /^bearer\s+(.+)$/i.exec(header);
    const token = m?.[1] ?? getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: "not authenticated" }, 401);
    const id = await v.verify(token);
    if (!id) return c.json({ error: "invalid token" }, 401);
    // Canonicalize the principal to lowercase: email is case-insensitive, and ownership
    // (site.owner) + the derived tenant namespace must agree. Without this, "Alice@x"
    // and "alice@x" become distinct DB owners that hash to the SAME tenant namespace —
    // two "tenants" sharing one isolation boundary.
    c.set("identity", { ...id, email: id.email.toLowerCase() });
    await next();
  });
}
