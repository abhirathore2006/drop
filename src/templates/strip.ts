// PURE publish "strip pass" for templates (D1). ZERO IO — the unit-test asset: table tests feed a stack
// spec (+ the org's known secret key names + an allow-list) and assert the stripped spec, the dropped
// env keys, the digest strips, and the credential FLAGS. The route runs this over a from-stack export
// (or a directly-supplied spec) and REFUSES to publish while any flag remains (fail-closed) unless the
// publisher passed `--allow <key>` for it (audited at the route).
//
// What it does, per the plan:
//   1. drops explicit `name:` overrides so template resources are STACK-RELATIVE (instantiate re-derives
//      `<stack>-<key>`); rewrites the concrete stack-name prefix inside env values to `${stack}`.
//   2. strips concrete image DIGESTS (`repo:tag@sha256:…` → `repo:tag`) — keeps `dir:` and mutable tags.
//   3. removes env keys already registered as write-only secrets (`app_secret_keys`) — they never belong
//      in a shared spec.
//   4. FLAGS remaining credential-looking env values (key-name heuristic AND value-entropy over a
//      threshold), unless the value is already variable-ized (`${var.…}`) or the key is on the allow-list.
import type { StackSpec, StackResource } from "../stack-config.ts";

export interface StripInput {
  spec: StackSpec;
  stackName?: string; // the concrete stack name to rewrite → `${stack}` (defaults to spec.name)
  secretKeyNames?: Record<string, string[]>; // resource KEY → its site's registered secret key names
  allow?: string[]; // env keys the publisher explicitly allows through (audited)
}

export interface StripFlag {
  resourceKey: string;
  envKey: string;
  reason: string;
}

export interface StripResult {
  spec: StackSpec; // stripped, template-relative spec
  flags: StripFlag[]; // credential-looking values still present (publish refuses while non-empty)
  removed: StripFlag[]; // env keys dropped (registered secrets)
  notes: string[]; // human-facing summary (digest strips, dropped names)
}

/** Env-var name heuristic: looks like it holds a credential. */
const SECRET_KEY_RE = /pass|secret|token|key|credential|priv/i;
/** Bits-per-char entropy above which a value is "credential-looking" (with a length floor to match). */
const ENTROPY_THRESHOLD = 3.0;
const ENTROPY_MIN_LEN = 8;
/** A concrete image digest suffix (`@sha256:<64 hex>`). */
const DIGEST_RE = /@sha256:[0-9a-fA-F]{64}$/;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shannon entropy in bits PER CHARACTER (0 for empty). A random token ≈ 4–5; "5432"/"require" ≈ ≤2.5. */
export function entropyBitsPerChar(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Whether a value is already variable-ized (contains a `${var.…}` reference) — safe, never flagged. */
const isVarRef = (v: string): boolean => /\$\{var\.[A-Za-z_][A-Za-z0-9_]*\}/.test(v);

/** Whether an env value looks like a hard-coded credential (used ONLY when the key name also looks secret). */
export function looksLikeCredential(value: string): boolean {
  return value.length >= ENTROPY_MIN_LEN && entropyBitsPerChar(value) >= ENTROPY_THRESHOLD;
}

/** Strip an image ref's concrete digest to its `repo[:tag]`. Returns the (possibly unchanged) ref +
 *  whether a digest was stripped. */
export function stripImageDigest(image: string): { image: string; stripped: boolean } {
  if (!DIGEST_RE.test(image)) return { image, stripped: false };
  return { image: image.replace(DIGEST_RE, ""), stripped: true };
}

/**
 * Run the strip pass. Pure: never touches the DB — `secretKeyNames` is supplied by the caller (which read
 * `app_secret_keys`). The result's `flags` being non-empty is the FAIL-CLOSED signal for the route.
 */
export function stripStackSpec(input: StripInput): StripResult {
  const stackName = input.stackName ?? input.spec.name;
  const secretKeyNames = input.secretKeyNames ?? {};
  const allow = new Set(input.allow ?? []);
  const flags: StripFlag[] = [];
  const removed: StripFlag[] = [];
  const notes: string[] = [];

  const clone = JSON.parse(JSON.stringify(input.spec)) as StackSpec;
  clone.name = stackName;
  const prefixRe = new RegExp("\\b" + escapeRegExp(stackName) + "\\b", "g");

  for (const [key, resUnknown] of Object.entries(clone.resources ?? {})) {
    const res = resUnknown as StackResource;

    // 1a) Drop explicit name overrides → template-relative (instantiate re-derives `<stack>-<key>`).
    if (res.name) {
      notes.push(`dropped explicit name "${res.name}" on resource "${key}" (template resources are stack-relative)`);
      delete res.name;
    }

    // 2) Strip concrete image digests (keep dir + mutable tags).
    if (typeof res.image === "string") {
      const { image, stripped } = stripImageDigest(res.image);
      if (stripped) {
        res.image = image;
        notes.push(`stripped image digest on "${key}" → ${image}`);
      }
    }

    if (res.env && typeof res.env === "object") {
      const knownSecrets = new Set(secretKeyNames[key] ?? []);
      for (const [envKey, rawVal] of Object.entries(res.env)) {
        const value = typeof rawVal === "string" ? rawVal : String(rawVal);

        // 3) Drop env keys registered as write-only secrets — never in a shared spec.
        if (knownSecrets.has(envKey)) {
          delete res.env[envKey];
          removed.push({ resourceKey: key, envKey, reason: "registered as a write-only secret (app_secret_keys)" });
          continue;
        }

        // 1b) Rewrite the concrete stack-name prefix inside the value → `${stack}`.
        const rewritten = value.replace(prefixRe, "${stack}");
        if (rewritten !== value) res.env[envKey] = rewritten;

        // 4) Flag credential-looking values (key-name heuristic AND entropy), unless variable-ized/allowed.
        if (allow.has(envKey) || isVarRef(rewritten)) continue;
        if (SECRET_KEY_RE.test(envKey) && looksLikeCredential(rewritten)) {
          flags.push({ resourceKey: key, envKey, reason: "credential-looking value (variable-ize it as ${var.…}, or --allow after confirming it is not a secret)" });
        }
      }
      if (Object.keys(res.env).length === 0) delete res.env;
    }
  }

  return { spec: clone, flags, removed, notes };
}
