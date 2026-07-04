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

export const apiExtra = {
  /** The signed-in user's orgs (personal + any team orgs). Powers the org switcher. */
  orgs: () => req<{ orgs: OrgSummary[] }>("GET", "/v1/orgs"),
  /** One org with its members — the Settings › Members panel. */
  orgDetail: (slug: string) => req<OrgDetail>("GET", `/v1/orgs/${encodeURIComponent(slug)}`),
  /** The CLI/API version this instance serves — the user-menu version chip. */
  version: () => req<{ version: string }>("GET", "/version"),
};
