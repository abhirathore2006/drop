// GoTrue adapter for the AuthEngine port (K1). GoTrue (MIT, Supabase's auth engine) is a single
// container + a Postgres schema, entirely env-configured — the reason it's the default engine.
//
// IMAGE PIN: docker.io/supabase/gotrue:v2.170.0 — a concrete, immutable v2 tag (NOT a moving `:v2`
// or `:latest`), so a tenant's login surface can't shift under a silent upstream push and the image
// is cacheable/air-gap-mirrorable. Bump deliberately, tracking GoTrue CVE advisories (Plan-v5
// Workstream K risk note); the Helm value `auth.engineImage` overrides it (+ an air-gap mirror note).
//
// JWT: HS256 only. OSS GoTrue signs/verifies with the single shared `GOTRUE_JWT_SECRET` — no
// asymmetric mode, no JWKS endpoint (see src/auth-resource/jwt.ts for the honest deviation write-up).
//
// EMAIL: v1 ships with verification OFF (`GOTRUE_MAILER_AUTOCONFIRM=true`) and no SMTP — magic
// links / password reset / verification emails are the deferred "K-mail" task. The config sanitizer
// reserves the `smtp:`/`email:` keys so K-mail is additive.
import type { AuthConfig, AuthProviderKind } from "../auth-config.ts";
import { jwtTtlSeconds } from "../auth-config.ts";
import type { AdminOp, AdminRoute, AuthEngine, EngineEnvContext } from "./engine.ts";
import { rbacHookEnv } from "./rbac-seed.ts";

// Concrete pinned tag — see the module header. Exported so Helm/docs reference ONE source of truth.
export const GOTRUE_IMAGE = "docker.io/supabase/gotrue:v2.170.0";
const GOTRUE_PORT = 9999;

// The GoTrue env-var STEM per provider kind (`GOTRUE_EXTERNAL_<STEM>_*`). OIDC maps to GoTrue's
// generic Keycloak provider (issuer → `..._URL`) — the one OSS GoTrue path that accepts an arbitrary
// OIDC issuer. Documented in docs/auth.html.
const PROVIDER_STEM: Record<AuthProviderKind, string> = { google: "GOOGLE", github: "GITHUB", oidc: "KEYCLOAK" };

export class GoTrueEngine implements AuthEngine {
  readonly id = "gotrue";
  readonly image: string;
  readonly containerPort = GOTRUE_PORT;
  readonly jwtAlg = "HS256" as const;
  readonly jwtSecretVar = "GOTRUE_JWT_SECRET";
  readonly dbUrlVar = "GOTRUE_DB_DATABASE_URL";
  readonly healthPath = "/health";

  constructor(image = GOTRUE_IMAGE) {
    this.image = image;
  }

  envFor(ctx: EngineEnvContext): Record<string, string> {
    const cfg = ctx.config;
    const siteUrl = cfg.site_url ?? cfg.redirect_urls[0] ?? ctx.apiExternalUrl;
    const env: Record<string, string> = {
      GOTRUE_API_HOST: "0.0.0.0",
      GOTRUE_API_PORT: String(GOTRUE_PORT),
      GOTRUE_DB_DRIVER: "postgres",
      // GoTrue creates + migrates its own schema (default `auth`) in the bound `app` database.
      API_EXTERNAL_URL: ctx.apiExternalUrl,
      GOTRUE_SITE_URL: siteUrl,
      GOTRUE_URI_ALLOW_LIST: cfg.redirect_urls.join(","),
      // JWT: HS256 with the shared secret (wired via valueFrom in the manifest layer, not here).
      GOTRUE_JWT_EXP: String(jwtTtlSeconds(cfg.jwt_ttl)),
      GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
      // The admin API accepts a token whose `role` is in this list — the server mints exactly that
      // (see jwt.mintAdminToken) for the user-admin proxy.
      GOTRUE_JWT_ADMIN_ROLES: "service_role",
      // Signup toggle. Email/password signup is the v1 path; `closed` → admin-created users only.
      GOTRUE_DISABLE_SIGNUP: String(cfg.signup === "closed"),
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
      // Email verification OFF (no SMTP in v1): a signed-up / admin-created user is usable immediately.
      GOTRUE_MAILER_AUTOCONFIRM: "true",
      // No SMTP relay yet — leave the mailer unconfigured (K-mail). Autoconfirm above means the
      // absent mailer never blocks the password / admin-created-user flows.
    };
    // Per-provider NON-secret env (enabled + client id + redirect uri). The provider SECRET is set
    // out-of-band into `<name>-secret` under GOTRUE_EXTERNAL_<STEM>_SECRET (see PROVIDER_SECRET_ENV)
    // and reaches the container via envFrom — never emitted here.
    for (const [kind, p] of Object.entries(cfg.providers ?? {})) {
      const stem = PROVIDER_STEM[kind as AuthProviderKind];
      env[`GOTRUE_EXTERNAL_${stem}_ENABLED`] = "true";
      env[`GOTRUE_EXTERNAL_${stem}_CLIENT_ID`] = p.client_id;
      env[`GOTRUE_EXTERNAL_${stem}_REDIRECT_URI`] = `${ctx.apiExternalUrl}/callback`;
      if (kind === "oidc" && p.issuer) env[`GOTRUE_EXTERNAL_${stem}_URL`] = p.issuer;
    }
    // (K2) App RBAC: plumb the custom-access-token hook env whenever `rbac: true`. The hook function
    // (public.drop_access_token_hook) is applied out-of-band via `drop auth rbac-seed` (v1); GoTrue
    // tolerates a not-yet-created hook function at boot and activates it once it exists. See rbac-seed.ts.
    if (cfg.rbac) Object.assign(env, rbacHookEnv());
    return env;
  }

  adminPath(op: AdminOp, arg?: string): AdminRoute {
    switch (op) {
      case "listUsers":
        return { method: "GET", path: "/admin/users" };
      case "createUser":
        return { method: "POST", path: "/admin/users" };
      case "getUser":
        return { method: "GET", path: `/admin/users/${arg}` };
      case "updateUser":
        return { method: "PUT", path: `/admin/users/${arg}` };
      case "deleteUser":
        return { method: "DELETE", path: `/admin/users/${arg}` };
    }
  }
}

export const gotrueEngine = new GoTrueEngine();
