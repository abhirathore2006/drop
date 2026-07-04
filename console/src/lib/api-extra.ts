// merge into api.ts — kept separate this round because api.ts is owned by a concurrent
// agent. Same-origin fetch carries the session cookie, identical to lib/api.ts's `req`
// (module-private there, so the tiny wrapper is duplicated here on purpose).

import { ApiError } from "./api.ts";

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: string }).error ?? `${path}: ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return json as T;
}

/** An org the signed-in user belongs to (GET /v1/orgs — the same list the CLI uses).
 *  `role` is the caller's role in that org. */
export interface OrgSummary {
  slug: string;
  name: string;
  kind: string; // "personal" | "team"
  role: string; // "owner" | "admin" | "member" | "viewer"
}

export interface OrgMember {
  email: string;
  role: string;
}

/** GET /v1/orgs/:slug — the org plus its member roster. */
export interface OrgDetail {
  slug: string;
  name: string;
  kind: string;
  members: OrgMember[];
}

/** A service-account / CI token (J1) as listed in Settings › Tokens. Never carries the secret/hash. */
export interface ServiceToken {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The create response — includes the one-time `token` secret (RevealOnce). */
export interface CreatedToken extends ServiceToken {
  token: string;
}

export const apiExtra = {
  /** The signed-in user's orgs (personal + any team orgs). Powers the org switcher. */
  orgs: () => req<{ orgs: OrgSummary[] }>("GET", "/v1/orgs"),
  /** One org with its members — the Settings › Members panel. */
  orgDetail: (slug: string) => req<OrgDetail>("GET", `/v1/orgs/${encodeURIComponent(slug)}`),
  // ---- org membership (M2) — owner/admin only (server-enforced via canManageOrg) ----
  addMember: (slug: string, email: string, role: string) => req<{ slug: string; email: string; role: string }>("POST", `/v1/orgs/${encodeURIComponent(slug)}/members`, { email, role }),
  removeMember: (slug: string, email: string) => req<{ removed: string }>("DELETE", `/v1/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(email)}`),
  /** Change an existing member's role. "owner" is not assignable (single-owner invariant). */
  setMemberRole: (slug: string, email: string, role: string) => req<{ slug: string; email: string; role: string }>("PATCH", `/v1/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(email)}`, { role }),
  /** The CLI/API version this instance serves — the user-menu version chip. */
  version: () => req<{ version: string }>("GET", "/version"),
  // ---- service accounts / scoped CI tokens (J1) — Settings › Tokens ----
  tokens: (slug: string) => req<{ tokens: ServiceToken[] }>("GET", `/v1/orgs/${encodeURIComponent(slug)}/tokens`),
  createToken: (slug: string, name: string, scopes: string[], expiresDays?: number) =>
    req<CreatedToken>("POST", `/v1/orgs/${encodeURIComponent(slug)}/tokens`, { name, scopes, ...(expiresDays ? { expires_days: expiresDays } : {}) }),
  revokeToken: (slug: string, id: string) => req<{ revoked: string; name: string }>("DELETE", `/v1/orgs/${encodeURIComponent(slug)}/tokens/${encodeURIComponent(id)}`),
};

/** The permission verbs a token scope may use (mirrors src/authz/permissions.ts ACTIONS). Kept here
 *  so the scope builder's verb <select> stays a static list — the server is the source of truth and
 *  rejects anything unknown with a clear 400. */
export const TOKEN_VERBS = ["read", "logs", "publish", "deploy", "db:create", "rollback", "configure", "expose", "share", "transfer", "delete"] as const;
