import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// (J2) Break-glass admin — the ONE local email/password account, for emergency access when the
// OIDC provider is unreachable. Email/password accounts are otherwise deliberately OUT of Drop
// (no signup, no password reset, no SMTP dependency — consistent with the K-mail deferral). This
// is a single env-configured credential (DROP_BREAK_GLASS_ADMIN), NOT a user store.
//
// Hashing is scrypt via node:crypto — no new dependency. The stored value is
//   "<email>:<saltHex>:<hashHex>"
// where hashHex = scrypt(password, salt, 64). Generate one with hashBreakGlass() (see SETUP_SSO.md).

const KEYLEN = 64;

export interface BreakGlassCredential {
  email: string;
  salt: Buffer;
  hash: Buffer;
}

/** Parse the DROP_BREAK_GLASS_ADMIN value "email:saltHex:hashHex" → credential, or null if malformed.
 *  The email is split on the FIRST colon (emails contain no colon); the remainder is salt:hash. */
export function parseBreakGlass(spec: string | undefined | null): BreakGlassCredential | null {
  if (!spec) return null;
  const i = spec.indexOf(":");
  if (i <= 0) return null;
  const email = spec.slice(0, i).trim().toLowerCase();
  const [saltHex, hashHex] = spec.slice(i + 1).split(":");
  if (!email || !saltHex || !hashHex) return null;
  const salt = Buffer.from(saltHex, "hex");
  const hash = Buffer.from(hashHex, "hex");
  if (salt.length === 0 || hash.length === 0) return null;
  return { email, salt, hash };
}

/** Constant-time verify of (email, password) against the DROP_BREAK_GLASS_ADMIN spec.
 *  Returns the canonical (lowercased) email on success, or null on any mismatch / when unset. */
export function verifyBreakGlass(spec: string | undefined | null, email: string, password: string): string | null {
  const cred = parseBreakGlass(spec);
  if (!cred) return null;
  if (cred.email !== email.trim().toLowerCase()) return null;
  const derived = scryptSync(password, cred.salt, cred.hash.length);
  if (derived.length !== cred.hash.length) return null;
  return timingSafeEqual(derived, cred.hash) ? cred.email : null;
}

/** Produce a DROP_BREAK_GLASS_ADMIN value for the given email + password. Used by the documented
 *  one-liner (SETUP_SSO.md) and the tests. */
export function hashBreakGlass(email: string, password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `${email.trim().toLowerCase()}:${salt.toString("hex")}:${hash.toString("hex")}`;
}
