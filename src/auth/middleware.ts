import { createMiddleware } from "hono/factory";
import type { Identity, Verifier } from "./types.ts";

export type AuthEnv = { Variables: { identity: Identity } };

/** Verifies the bearer token and injects the Identity into the Hono context. */
export function authMiddleware(v: Verifier) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const m = /^bearer\s+(.+)$/i.exec(header);
    if (!m) return c.json({ error: "missing bearer token" }, 401);
    const id = await v.verify(m[1]!);
    if (!id) return c.json({ error: "invalid token" }, 401);
    c.set("identity", id);
    await next();
  });
}
