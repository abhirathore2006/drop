// JWT key material + a minimal HS256 signer/verifier for the managed auth resource (K1).
//
// SHIPPED: HS256 (symmetric). OSS GoTrue (docker.io/supabase/gotrue) verifies and signs its tokens
// with a single shared `GOTRUE_JWT_SECRET` — it has NO asymmetric-key mode and serves NO JWKS
// endpoint (that is a Supabase-platform feature, not in the OSS image). So per the plan's escape
// hatch ("IF asymmetric isn't cleanly supported by the image, ship HS256 v1 … document the deviation
// + the JWKS consequence honestly") we ship HS256. Consequences, documented in docs/auth.html:
//   - There is NO `/.well-known/jwks.json` — a binding app verifies tokens with the SHARED SECRET
//     (`AUTH_JWT_SECRET`, injected via the write-only path), not a public key.
//   - `rotate-keys` re-mints the secret; GoTrue itself verifies with only the CURRENT secret, so the
//     grace window is realized for BINDING APPS by injecting BOTH the new and previous secret
//     (`AUTH_JWT_SECRET` + `AUTH_JWT_SECRET_PREVIOUS`) until the next rotation.
//
// The server also mints a short-TTL service-role admin JWT (same secret) to call GoTrue's admin API
// on behalf of a `configure`-gated console/CLI user (see the user-admin proxy in server.ts).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Generate a fresh HS256 shared secret (256 bits, base64url — safe as a plain string env value). */
export function generateJwtSecret(): string {
  return randomBytes(32).toString("base64url");
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/** Sign an HS256 JWT over `claims` with `secret`. `iat`/`exp` are stamped from `nowS` + `ttlS`. */
export function signHs256(secret: string, claims: Record<string, unknown>, opts: { ttlS: number; nowS?: number }): string {
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iat: now, exp: now + opts.ttlS, ...claims };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

/** A short-TTL service-role admin token GoTrue's admin API accepts (role must be in
 *  GOTRUE_JWT_ADMIN_ROLES, which the engine sets to `service_role`). Kept SHORT (default 60s) — it's
 *  minted per admin request, never stored, and only ever leaves the server toward the in-cluster
 *  engine. `aud`/`iss` mirror what GoTrue stamps so its own validators are satisfied. */
export function mintAdminToken(secret: string, opts: { ttlS?: number; nowS?: number } = {}): string {
  return signHs256(secret, { role: "service_role", aud: "authenticated", iss: "drop-auth" }, { ttlS: opts.ttlS ?? 60, nowS: opts.nowS });
}

/** Verify + decode an HS256 JWT against `secret` (constant-time signature compare + exp check). Returns
 *  the payload, or null on any failure. Used by the isolation test (resource A's token must fail
 *  resource B's secret) and available to callers that verify server-side. */
export function verifyHs256(secret: string, token: string, nowS = Math.floor(Date.now() / 1000)): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp < nowS) return null;
  return payload;
}
