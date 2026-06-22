// Pure helpers for the app-secrets feature. No I/O — the SecretStore port (types.ts) does that.
import { createHash } from "node:crypto";

const KEY_RE = /^[A-Z_][A-Z0-9_]{0,255}$/; // a POSIX-ish env-var name

/** Validate a secret KEY (the env-var name). Returns an error string, or null if acceptable. */
export function validateSecretKey(key: unknown): string | null {
  if (typeof key !== "string") return "key must be a string";
  if (!KEY_RE.test(key)) return "key must be an UPPER_SNAKE_CASE env-var name (≤256 chars, no leading digit)";
  return null;
}

/** A short, non-reversible digest of a value — lets the UI show "changed" without ever
 *  revealing the value. NOT a security control; just change-detection. */
export function fingerprint(value: string): string {
  return createHash("sha256").update("drop-secret\0").update(value).digest("hex").slice(0, 12);
}
