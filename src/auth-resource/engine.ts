// The AuthEngine PORT (K1). Drop owns the auth resource's lifecycle + wiring, never the auth engine's
// internals (password hashing, session rotation, OAuth linking, token issuance — the most dangerous
// code one can write). GoTrue is the default engine behind this port (src/auth-resource/gotrue.ts);
// a future swap (better-auth/SuperTokens) is a NEW adapter implementing this interface, not a redesign.
//
// The port is deliberately three small surfaces: (1) the pinned `image` + `containerPort`, (2) an
// env MAPPING (`envFor` → a plain string→string map of the engine's NON-secret, NON-valueFrom config
// env; the manifest layer adds the DB-creds/JWT-secret valueFrom entries + the interpolated
// DATABASE_URL — k8s `$(VAR)` mechanics a string map can't carry), and (3) admin-API routing
// (`adminPath`) so the server-side user-admin proxy is engine-agnostic.
import type { AuthConfig } from "../auth-config.ts";

/** The admin operations the user-admin proxy performs (server-side, gated + audited). */
export type AdminOp = "listUsers" | "createUser" | "getUser" | "deleteUser" | "updateUser";

export interface AdminRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // relative to the engine base (e.g. "/admin/users")
}

/** Everything the engine needs to compute its config env for one resource. */
export interface EngineEnvContext {
  name: string; // the auth resource name
  apiExternalUrl: string; // https://auth--<name>.<baseDomain>
  config: AuthConfig; // the sanitized `auth:` config
}

export interface AuthEngine {
  readonly id: string; // "gotrue" — the engine identifier (labels/logs)
  readonly image: string; // pinned image ref (see gotrue.ts / Helm values)
  readonly containerPort: number; // the engine's HTTP port
  readonly jwtAlg: "HS256"; // v1: HS256 (see jwt.ts for the asymmetric-vs-HS256 decision)
  readonly jwtSecretVar: string; // the env var name carrying the JWT secret (valueFrom the keys Secret)
  readonly dbUrlVar: string; // the env var name carrying the composed Postgres DATABASE_URL
  readonly healthPath: string; // the engine's readiness/liveness HTTP path
  /** NON-secret, NON-valueFrom config env for the engine, derived from the sanitized config + context. */
  envFor(ctx: EngineEnvContext): Record<string, string>;
  /** Map an admin op → the engine's admin REST route (method + path). `arg` is the user id/email. */
  adminPath(op: AdminOp, arg?: string): AdminRoute;
}

/** A deterministic in-memory engine for tests: predictable env keys + admin routes, no real image. */
export class FakeEngine implements AuthEngine {
  readonly id = "fake";
  readonly image = "drop.local/fake-auth:test";
  readonly containerPort = 9999;
  readonly jwtAlg = "HS256" as const;
  readonly jwtSecretVar = "FAKE_JWT_SECRET";
  readonly dbUrlVar = "FAKE_DATABASE_URL";
  readonly healthPath = "/health";
  // A recording surface the user-admin proxy tests assert against.
  readonly adminCalls: { op: AdminOp; arg?: string; body?: unknown; token: string }[] = [];
  // Canned users the fake admin API "returns" (the proxy test seeds/reads these).
  users: { id: string; email: string; banned?: boolean }[] = [];
  envFor(ctx: EngineEnvContext): Record<string, string> {
    return {
      FAKE_SITE_URL: ctx.config.site_url ?? ctx.apiExternalUrl,
      FAKE_SIGNUP: ctx.config.signup,
      FAKE_EXTERNAL_URL: ctx.apiExternalUrl,
    };
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
