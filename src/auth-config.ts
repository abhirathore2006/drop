// Per-auth-resource config, declared under `auth:` in drop.yaml (sibling to `app:`/`database:`/`cache:`).
// Parsed at create time; the engine port (src/auth-resource/) maps it into GoTrue env. Mirrors the
// other per-type sanitizers (defensive, junk-ignoring, round-trip safe: re-sanitizing an AuthConfig
// yields the same AuthConfig).
//
// SECRET BOUNDARY: provider CLIENT IDs live here (non-secret, safe in the spec); provider SECRETS never
// do — they're written out-of-band via `drop secrets set <auth> GOTRUE_EXTERNAL_<PROVIDER>_SECRET=…`
// into the resource's write-only `<name>-secret` Secret, which the engine Deployment envFroms.
//
// K-MAIL BOUNDARY (deferred, per Plan-v5 Workstream K): everything requiring outbound email — magic
// links, password reset, verification emails, invites — is out of v1. We RESERVE the `email`/`smtp`
// keys now (accepted + stored, ignored by the engine mapping) so K-mail is purely additive: a config
// authored today with `smtp:` round-trips unchanged and lights up when K-mail ships. Email
// verification is OFF in v1 (GOTRUE_MAILER_AUTOCONFIRM=true).
import { parse as parseYaml } from "yaml";

export type SignupMode = "open" | "closed";

/** One OAuth/OIDC provider's NON-SECRET config. The client secret is NEVER here (write-only path). */
export interface AuthProvider {
  client_id: string;
  issuer?: string; // OIDC only: the discovery issuer URL (google/github are well-known)
}

export interface AuthConfig {
  name?: string;
  providers?: Partial<Record<AuthProviderKind, AuthProvider>>; // google | github | oidc
  redirect_urls: string[]; // the OAuth/site redirect allowlist (GOTRUE_URI_ALLOW_LIST)
  site_url?: string; // the app's canonical URL (GOTRUE_SITE_URL); defaults to the first redirect
  jwt_ttl: string; // access-token TTL, a duration string ("1h", "30m"); default "1h"
  signup: SignupMode; // "open" (default) — anyone may sign up; "closed" — admin-created users only
  // (K2) App RBAC. When true, Drop plumbs the GoTrue custom-access-token hook env onto the engine and
  // `drop auth rbac-seed <name>` prints the Supabase-pattern roles/permissions schema + claims-hook
  // function to apply against the bound database. App-defined vocabulary; disjoint from platform can().
  rbac?: boolean;
  // Reserved for K-mail (accepted + stored, NOT mapped to engine env in v1). Sanitized to a plain
  // string→string map so it round-trips unchanged; the engine ignores it until K-mail wires SMTP.
  smtp?: Record<string, string>;
  email?: Record<string, string>;
}

export type AuthProviderKind = "google" | "github" | "oidc";
const PROVIDER_KINDS: readonly AuthProviderKind[] = ["google", "github", "oidc"];

const DEFAULT_JWT_TTL = "1h";
const MAX_REDIRECTS = 32;
const DURATION_RE = /^\d+\s*(s|m|h)?$/;

function str(v: unknown, max = 2048): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** Parse a duration ("1h"/"30m"/"3600"/3600) to whole seconds; junk/absent → undefined. Bounded to
 *  [60s, 24h] so a typo can't mint a token that lives forever or expires instantly. */
export function jwtTtlSeconds(ttl: string): number {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(ttl.trim());
  if (!m) return 3600;
  const mult = m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
  const s = parseInt(m[1]!, 10) * mult;
  return Math.min(24 * 3600, Math.max(60, s));
}

/** Accept only http(s) absolute URLs (no `javascript:`/relative junk) for the redirect allowlist and
 *  the site URL — a bad redirect entry is an open-redirect footgun, so drop it rather than coerce. */
function url(v: unknown): string | undefined {
  const s = str(v, 2048);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeProvider(v: unknown, kind: AuthProviderKind): AuthProvider | undefined {
  if (!v || typeof v !== "object") return undefined;
  const raw = v as Record<string, unknown>;
  // accept drop.yaml's `client_id` AND the sanitized shape (round-trip safe).
  const client_id = str(raw.client_id ?? raw.clientId, 512);
  if (!client_id) return undefined; // a provider with no client id is meaningless — drop it
  const p: AuthProvider = { client_id };
  if (kind === "oidc") {
    const issuer = url(raw.issuer);
    if (!issuer) return undefined; // OIDC requires a discovery issuer
    p.issuer = issuer;
  }
  return p;
}

/** A reserved (K-mail) `smtp:`/`email:` block → a flat string map, ignoring non-string values. Stored
 *  verbatim so it round-trips; the engine mapping does NOT read it in v1 (email flows are deferred). */
function sanitizeStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = str(val, 2048);
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Sanitize a parsed `auth:` object → AuthConfig. Returns undefined only for a clearly-invalid scalar;
 * an empty/null object yields a default resource (open signup, 1h TTL, no providers/redirects — the
 * password + admin-created-user path works with zero config). Round-trip safe.
 */
export function sanitizeAuthConfig(input: unknown): AuthConfig | undefined {
  if (input != null && typeof input !== "object") return undefined;
  const raw = (input ?? {}) as Record<string, unknown>;

  const cfg: AuthConfig = {
    redirect_urls: [],
    jwt_ttl: DEFAULT_JWT_TTL,
    signup: raw.signup === "closed" ? "closed" : "open",
  };

  const name = str(raw.name, 63);
  if (name) cfg.name = name;

  const ttl = str(raw.jwt_ttl ?? raw.jwtTtl, 16);
  if (ttl && DURATION_RE.test(ttl.trim())) cfg.jwt_ttl = ttl.trim();

  // (K2) rbac is a plain boolean; only `true` is stored (round-trip safe — false/absent → omitted).
  if (raw.rbac === true) cfg.rbac = true;

  if (Array.isArray(raw.redirect_urls ?? raw.redirectUrls)) {
    const seen = new Set<string>();
    for (const r of ((raw.redirect_urls ?? raw.redirectUrls) as unknown[]).slice(0, MAX_REDIRECTS)) {
      const u = url(r);
      if (u && !seen.has(u)) {
        seen.add(u);
        cfg.redirect_urls.push(u);
      }
    }
  }

  const siteUrl = url(raw.site_url ?? raw.siteUrl);
  if (siteUrl) cfg.site_url = siteUrl;

  if (raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers)) {
    const providers: Partial<Record<AuthProviderKind, AuthProvider>> = {};
    for (const kind of PROVIDER_KINDS) {
      const p = sanitizeProvider((raw.providers as Record<string, unknown>)[kind], kind);
      if (p) providers[kind] = p;
    }
    if (Object.keys(providers).length) cfg.providers = providers;
  }

  // Reserved K-mail blocks — accepted + stored, ignored by the engine mapping in v1.
  const smtp = sanitizeStringMap(raw.smtp);
  if (smtp) cfg.smtp = smtp;
  const email = sanitizeStringMap(raw.email);
  if (email) cfg.email = email;

  return cfg;
}

/** Parse a `drop.yaml` body and return its `auth:` section, or undefined if absent. */
export function parseAuthConfig(text: string): AuthConfig | undefined {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || !("auth" in doc)) return undefined;
  return sanitizeAuthConfig((doc as Record<string, unknown>).auth);
}

/** The write-only Secret KEY names a provider's client SECRET must be set under (documented in
 *  docs/auth.html). `drop secrets set <auth> <KEY>=<value>` writes into the engine's `<name>-secret`. */
export const PROVIDER_SECRET_ENV: Record<AuthProviderKind, string> = {
  google: "GOTRUE_EXTERNAL_GOOGLE_SECRET",
  github: "GOTRUE_EXTERNAL_GITHUB_SECRET",
  oidc: "GOTRUE_EXTERNAL_KEYCLOAK_SECRET",
};
