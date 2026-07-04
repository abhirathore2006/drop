// PURE variable substitution for template instantiation (D1). ZERO IO — the unit-test asset: table
// tests feed (templateSpec, variables, values, stackName) and assert the concrete spec, the extracted
// secrets, and the missing-required list. Two placeholders are substituted across every STRING value of
// the spec (deep walk):
//   ${var.KEY}  — a declared variable's value (`values[key]` wins, else its `default`).
//   ${stack}    — the target stack name (so template-relative hostnames like `${stack}-db-rw` resolve).
//
// SECRET SEPARATION (load-bearing): a variable declared `secret:true` must NEVER land in the stored /
// returned spec. A secret variable may ONLY be used as the WHOLE value of a resource `env` entry
// (`env: { PGPASSWORD: "${var.db_password}" }`). Those entries are LIFTED OUT of the spec into a
// `secretsToSet` plan — `{ resourceKey, envKey, value }` — that the caller writes through the write-only
// secret path AFTER the up (never stored in the template or the stack spec). A secret variable used
// anywhere else (interpolated inside a larger string, or in a non-env field) is a hard error.
import { sanitizeStackConfig, type StackSpec } from "../stack-config.ts";

/** A template variable declaration (stored in `template_versions.variables`). */
export interface TemplateVariable {
  key: string;
  description?: string;
  default?: string;
  required: boolean;
  secret?: boolean;
}

/** One write-only secret the caller must set after the up (never in the spec). */
export interface SecretToSet {
  resourceKey: string; // the stack resource KEY whose app receives the secret
  envKey: string; // the env-var name (the map key it replaced)
  value: string; // the resolved secret value
}

export interface SubstituteResult {
  spec: StackSpec; // concrete, secret env entries removed
  secretsToSet: SecretToSet[]; // lifted secret env entries
  missing: string[]; // required variables with no value (and no default)
  errors: string[]; // misuse (unknown var, secret used outside a whole env value)
}

/** A `${var.KEY}` or `${stack}` token. KEY is env-var-shaped. */
const TOKEN_RE = /\$\{(var\.[A-Za-z_][A-Za-z0-9_]*|stack)\}/g;
/** An env value that is EXACTLY one `${var.KEY}` reference (the only legal place for a secret var). */
const WHOLE_VAR_RE = /^\$\{var\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Validate a variable key (env-var-shaped). Returns an error string, or null. */
export function validateVarKey(key: unknown): string | null {
  if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) return "variable key must be 1–64 chars, letters/digits/underscore, not starting with a digit";
  return null;
}

/**
 * Sanitize a raw `variables` payload → a validated TemplateVariable[], or an ERROR STRING (for a 400).
 * Junk-ignoring like the other sanitizers: unknown fields are dropped, but a malformed key or a duplicate
 * key is a hard error (a template with two `${var.x}` declarations is ambiguous). Bounded at 32 variables.
 */
export function sanitizeVariables(input: unknown): TemplateVariable[] | string {
  if (input == null) return [];
  if (!Array.isArray(input)) return "variables must be an array of { key, description?, default?, required, secret? }";
  if (input.length > 32) return "too many variables (max 32)";
  const out: TemplateVariable[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return "each variable must be an object";
    const r = raw as Record<string, unknown>;
    const keyErr = validateVarKey(r.key);
    if (keyErr) return keyErr;
    const key = r.key as string;
    if (seen.has(key)) return `duplicate variable "${key}"`;
    seen.add(key);
    const v: TemplateVariable = { key, required: r.required === true };
    if (typeof r.description === "string" && r.description.length) v.description = r.description.slice(0, 500);
    if (typeof r.default === "string") v.default = r.default.slice(0, 4096);
    if (r.secret === true) v.secret = true;
    out.push(v);
  }
  return out;
}

/** The effective (non-secret-aware) value of a variable: an explicit value wins over its default. */
function effectiveValue(v: TemplateVariable, values: Record<string, string>): string | undefined {
  const provided = values[v.key];
  if (typeof provided === "string" && provided.length > 0) return provided;
  if (typeof v.default === "string") return v.default;
  return undefined;
}

/**
 * Substitute a template spec into a concrete stack spec for `stackName`.
 *  - Required variables with no value (and no default) are collected in `missing`; when any are missing
 *    the result spec is the (partial) input and the caller should 400.
 *  - Secret env entries (`env[K] === "${var.SECRET}"`) are lifted into `secretsToSet` and removed.
 *  - Remaining `${var.X}` / `${stack}` tokens are replaced across all string values (deep walk).
 *  - Misuse (unknown var, or a secret var used anywhere but a whole env value) → `errors`.
 * The result spec is re-sanitized so it round-trips exactly like any other stored stack spec.
 */
export function substituteTemplate(
  templateSpec: StackSpec,
  variables: TemplateVariable[],
  values: Record<string, string>,
  stackName: string,
): SubstituteResult {
  const byKey = new Map(variables.map((v) => [v.key, v] as const));
  const errors: string[] = [];
  const missing: string[] = [];

  // Required-variable check up front (a required var with neither a value nor a default is missing).
  for (const v of variables) {
    if (v.required && effectiveValue(v, values) === undefined) missing.push(v.key);
  }

  // Work on a structural clone so the caller's input is never mutated; re-sanitize at the end.
  const clone = JSON.parse(JSON.stringify(templateSpec)) as StackSpec;
  clone.name = stackName;

  const secretsToSet: SecretToSet[] = [];

  // 1) Lift secret env entries out of every resource's `env` map. A secret var is ONLY valid here.
  const resources = (clone.resources ?? {}) as Record<string, { env?: Record<string, string> }>;
  for (const [resourceKey, res] of Object.entries(resources)) {
    if (!res || typeof res !== "object" || !res.env) continue;
    for (const [envKey, raw] of Object.entries(res.env)) {
      const m = typeof raw === "string" ? WHOLE_VAR_RE.exec(raw) : null;
      if (!m) continue;
      const varName = m[1]!;
      const decl = byKey.get(varName);
      if (!decl?.secret) continue; // a non-secret whole-value ref falls through to normal substitution
      delete res.env[envKey];
      if (missing.includes(varName)) continue; // required-but-missing secret: reported via `missing`
      const value = effectiveValue(decl, values);
      if (value === undefined) continue; // optional secret with no value → simply not set
      secretsToSet.push({ resourceKey, envKey, value });
    }
    if (res.env && Object.keys(res.env).length === 0) delete res.env; // don't leave an empty env behind
  }

  // 2) Deep-walk every remaining STRING value, replacing ${var.X} / ${stack}. A secret var reaching here
  //    is misuse (it wasn't a whole env value). If we already have `missing`/`errors`, we still walk so
  //    the error set is complete, but the caller won't apply a spec with either non-empty.
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return replaceTokens(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  const replaceTokens = (s: string): string =>
    s.replace(TOKEN_RE, (_full, token: string) => {
      if (token === "stack") return stackName;
      const key = token.slice(4); // strip "var."
      const decl = byKey.get(key);
      if (!decl) {
        errors.push(`unknown variable "${key}"`);
        return _full;
      }
      if (decl.secret) {
        errors.push(`secret variable "${key}" may only be used as a whole env value`);
        return _full;
      }
      return effectiveValue(decl, values) ?? "";
    });

  const walked = walk(clone) as StackSpec;
  // Re-sanitize so the concrete spec is byte-for-byte a valid stored stack spec (junk-ignoring, round-trip
  // safe). If substitution somehow produced an invalid spec, fall back to the walked object so the caller
  // still sees a coherent shape (validation/edge checks happen at the route).
  const spec = sanitizeStackConfig(walked) ?? walked;

  return { spec, secretsToSet, missing, errors };
}
