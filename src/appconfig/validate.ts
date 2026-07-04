// (L4) PURE validators for the runtime-config KV — no IO, no DB. Kept separate from store.ts so the CLI
// can import the SAME credential-refusal + key/size checks the server enforces WITHOUT dragging kysely
// into its bundle (store.ts imports the query builder; this file imports only the D1 entropy detector).
import { entropyBitsPerChar } from "../templates/strip.ts";

/** Same env-var-name keyword heuristic as the D1 strip pass (templates/strip.ts's private SECRET_KEY_RE):
 *  a KEY whose name reads like it holds a credential. Mirrored here (strip.ts keeps its copy private). */
const SECRET_KEY_RE = /pass|secret|token|key|credential|priv/i;
/** A sane, env-var-ish config key: a letter/underscore start, then letters/digits/underscore/dot; ≤128.
 *  Deliberately looser than the UPPER_SNAKE secret-key rule (config keys read like `feature.newUi` too),
 *  but still shell-safe and small. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
/** Value size cap — config values are small, non-secret knobs. 4 KiB. */
export const MAX_VALUE_BYTES = 4 * 1024;
/** A URL value (a legit non-secret config: a base/webhook URL) — exempt from the value-entropy net. */
const URL_RE = /^https?:\/\//i;
/** The value-entropy net's bar: an OPAQUE credential is contiguous (no whitespace), reasonably long, and
 *  high-entropy. Prose and URLs have whitespace / are exempted, so they never trip it. Higher than D1's
 *  entropy floor (3.0) because D1 pairs it with a secret-y KEY gate (an AND) — here it stands alone, so it
 *  must clear natural-language config (~3.5–4 bits/char at the char level) without false-flagging it. */
const OPAQUE_MIN_LEN = 12;
const OPAQUE_ENTROPY = 3.5;

/** Thrown by the store's `set` when a key/value is rejected. `.reason` is machine-readable; `.message` is
 *  the human-facing text the API/CLI surface verbatim (so both reject with the same clear wording). */
export class ConfigValidationError extends Error {
  readonly reason: "bad_key" | "too_large" | "looks_secret";
  constructor(message: string, reason: "bad_key" | "too_large" | "looks_secret") {
    super(message);
    this.name = "ConfigValidationError";
    this.reason = reason;
  }
}

/** Validate a config KEY. Returns an error string, or null if acceptable. */
export function validateConfigKey(key: unknown): string | null {
  if (typeof key !== "string") return "key must be a string";
  if (!KEY_RE.test(key)) return "key must be an env-var-ish name (letter/underscore start, then letters, digits, _ or ., ≤128 chars)";
  return null;
}

/** The credential refusal (reused by the API route AND the CLI so both reject client-side with the same
 *  message). Returns an error string when the key/value looks like a secret, else null. Two signals, both
 *  reusing the D1 entropy detector's spirit:
 *   1. the KEY name reads secret-y (`API_KEY`, `DB_PASSWORD`, `STRIPE_SECRET`, …) — the primary, high-signal
 *      rule (a config KV named PASSWORD is secret misuse whatever its value); and
 *   2. the VALUE is an OPAQUE credential — contiguous (no whitespace), ≥12 chars, non-URL, high-entropy —
 *      a net for `BLOB=sk_live_…`. It deliberately exempts prose (whitespace) and URLs so legitimate
 *      non-secret config (a welcome message, a base URL) is never flagged.
 *  Either match steers the user to `drop secrets set`. */
export function looksLikeSecret(key: string, value: string): string | null {
  const refuse = "looks like a secret — use `drop secrets set` (config values are non-secret and stored in plaintext)";
  if (SECRET_KEY_RE.test(key)) return refuse;
  const opaque = value.length >= OPAQUE_MIN_LEN && !/\s/.test(value) && !URL_RE.test(value);
  if (opaque && entropyBitsPerChar(value) >= OPAQUE_ENTROPY) return refuse;
  return null;
}
