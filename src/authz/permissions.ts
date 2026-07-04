import type { OrgRole, SiteRole } from "../db/schema.ts";

// The permission verbs. Kept as a runtime array (not just a type) so the scope grammar (J1) can
// validate a token's scopes against the SAME source of truth `can()` enforces. `Action` derives
// from it, so the two can never drift.
export const ACTIONS = ["read", "logs", "publish", "deploy", "db:create", "connect", "exec", "query", "rollback", "configure", "expose", "share", "transfer", "delete"] as const;
export type Action = (typeof ACTIONS)[number];

export interface Actor {
  email: string;
  platformRole: "admin" | "member";
  siteRole: SiteRole | null; // null = not a per-resource member of this site
  orgRole: OrgRole | null; // role in the RESOURCE's owning org (null = not an org member)
  token?: TokenGrant; // present iff this is a SERVICE-TOKEN actor (J1) — grants come from scopes, not roles
}

/** A service-token actor's grant context (J1). A token NEVER has roles: its authority is the union of
 *  its `scopes`, fenced to its own `orgId` and to the single resource `can()` is being asked about. */
export interface TokenGrant {
  scopes: string[];
  orgId: string; // the org the token belongs to
  resourceName: string; // the resource `can()` is being asked about (matched against `verb:name`)
  resourceOrgId: string | null; // that resource's owning org (must equal `orgId`, else cross-org deny)
}

/** One parsed scope: a verb plus a resource selector. A bare `verb` (or `verb:*`) → resource `"*"`
 *  = every resource. `verb:name` → that one resource. `null` when the string names no known verb. */
export interface ParsedScope {
  verb: Action;
  resource: string; // "*" = all resources
}

// Match the LONGEST verb first so `db:create` (a verb that itself contains a colon) is never mis-split
// into verb `db` + resource `create`. Resource names are DNS-safe (validateName) — never colon-bearing —
// so `<verb>:<resource>` is unambiguous once the verb is anchored to the known set.
const VERBS_LONGEST_FIRST = [...ACTIONS].sort((a, b) => b.length - a.length);

/** Parse a scope string into `{verb, resource}`, or null if it names no known verb (J1 grammar:
 *  `verb` | `verb:resourceName` | `verb:*`). */
export function parseScope(s: string): ParsedScope | null {
  for (const v of VERBS_LONGEST_FIRST) {
    if (s === v) return { verb: v, resource: "*" }; // bare verb → all resources
    if (s.startsWith(v + ":")) {
      const resource = s.slice(v.length + 1);
      return resource ? { verb: v, resource } : null; // `verb:` (empty resource) is invalid
    }
  }
  return null;
}

/** Validate a token's scope list. Returns an error string, or null if every scope is well-formed.
 *  Rejects a non-array / empty list and any scope whose verb isn't one of the real permission verbs. */
export function validateScopes(scopes: unknown): string | null {
  if (!Array.isArray(scopes) || scopes.length === 0) return "at least one scope is required (e.g. deploy:myapp or publish:*)";
  for (const s of scopes) {
    if (typeof s !== "string") return "each scope must be a string";
    if (!parseScope(s)) return `invalid scope "${s}": expected <verb>[:<resource>|:*], verb one of ${ACTIONS.join(", ")}`;
  }
  return null;
}

/** Pure grant check for a scope list (J1). True iff some scope grants `verb` on `resource` — either a
 *  wildcard (`verb` / `verb:*`) or an exact `verb:resource` match. The core of the token-actor path. */
export function scopeAllows(scopes: string[], verb: Action, resource: string): boolean {
  for (const s of scopes) {
    const p = parseScope(s);
    if (!p || p.verb !== verb) continue;
    if (p.resource === "*" || p.resource === resource) return true;
  }
  return false;
}

// read = see the workload in the dashboard / its versions & settings.
// logs = read pod logs — gated ABOVE viewer: logs can contain env-injected secrets, and a
//   viewer is deliberately metadata-only (it never sees the credentials Secret).
// publish = ship a static-site version; deploy = ship a container-app revision.
// db:create = provision/update a managed database. configure = set visibility / password / secrets.
// expose = turn TCP (L4) exposure on/off for a workload (A2b). Mapped to the SAME tier as deploy —
//   the ship/manage tier (site owner+editor, org owner/admin/member) — because exposure is a
//   deploy-adjacent operation an editor drives, and it's already fenced (opt-in, default off, audited,
//   protocol-native auth + a NetworkPolicy that only allows edge-tcp → the specifically-exposed pod).
// connect = open an authenticated `db:proxy` tunnel to a managed database (A3). Deliberately ABOVE
//   viewer — a viewer is metadata-only and must never open a raw SQL session — and mapped to the
//   deploy/ship tier (site owner+editor, org owner/admin/member): opening a psql tunnel is a routine
//   developer action, not an owner-only configure. Service tokens get it via the scope grammar
//   (`connect:<db>`). Every redemption is audited (`db.tunnel.open`).
// exec = open an authenticated interactive `drop exec` shell into a running APP pod (J3). Same tier as
//   `connect`/`deploy` (site owner+editor, org owner/admin/member) — but note the framing is STRICTER
//   than `logs`: a shell can `env` the container, so an app's WRITE-ONLY injected secrets (its
//   DATABASE_PASSWORD, API keys, …) become READABLE to anyone who can exec. `logs` merely MIGHT echo a
//   secret a process happens to print; `exec` hands the caller the whole environment on demand. It is
//   gated at editor+ (never viewer) for that reason, every session is audited WITH the command
//   (`app.exec`), and service tokens get it via the scope grammar (`exec:<app>`).
// query = run a READ-ONLY SQL query against a managed database over the API's SQL console (I4). Gated
//   at editor+ (owner/editor, org owner/admin/member) — deliberately ABOVE `read` and STRICTER than it:
//   `read` is metadata-only (name/status/versions), but a query returns ALL row data from every table,
//   so a metadata-only viewer must never hold it. Same ship/dev tier as `connect`/`exec` (opening a SQL
//   session is a routine developer action, not an owner-only configure). Read-only is SESSION-enforced
//   by the executor (BEGIN READ ONLY), not parsed — the verb only gates WHO may run a statement. Every
//   query is audited WITH the statement (`db.query`); service tokens get it via the grammar (`query:<db>`).
const SITE_MAP: Record<SiteRole, Action[]> = {
  owner: ["read", "logs", "publish", "deploy", "db:create", "connect", "exec", "query", "rollback", "configure", "expose", "share", "transfer", "delete"],
  editor: ["read", "logs", "publish", "deploy", "db:create", "connect", "exec", "query", "rollback", "expose"],
  viewer: ["read"],
};

// Org roles apply org-WIDE (every resource in the org). owner/admin manage everything; member is the
// day-to-day (ship + configure/secrets + expose + connect, but not share/transfer/delete a resource);
// viewer reads (and, deliberately, may NOT open a db:proxy tunnel — connect is above viewer).
const ORG_MAP: Record<OrgRole, Action[]> = {
  owner: ["read", "logs", "publish", "deploy", "db:create", "connect", "exec", "query", "rollback", "configure", "expose", "share", "transfer", "delete"],
  admin: ["read", "logs", "publish", "deploy", "db:create", "connect", "exec", "query", "rollback", "configure", "expose", "share", "transfer", "delete"],
  member: ["read", "logs", "publish", "deploy", "db:create", "connect", "exec", "query", "rollback", "configure", "expose"],
  viewer: ["read"],
};

/** The single authority check. Platform admins are all-powerful; otherwise the UNION of the actor's
 *  org-wide role and any per-resource grant (so the broader of the two wins, never the narrower). */
export function can(actor: Actor, action: Action): boolean {
  // Service-token actor (J1): authority comes ENTIRELY from scopes — never roles. A token is fenced to
  // (a) its OWN org — the resource's org must match, else deny (cross-org / org-less resource); and
  // (b) what its scopes grant for THIS resource. It is deliberately NEVER a platform admin.
  // Admin / user-management / org-management surfaces (isPlatformAdmin, canManageOrg, canCreateInOrg)
  // are unreachable to a token by construction: its principal is `token:…@org` — no user row and no org
  // membership — so those checks always fail for it. This branch adds no new surface; it only grants
  // resource verbs. Explicit deny of everything outside its org + scopes.
  if (actor.token) {
    if (actor.token.resourceOrgId == null || actor.token.resourceOrgId !== actor.token.orgId) return false;
    return scopeAllows(actor.token.scopes, action, actor.token.resourceName);
  }
  if (actor.platformRole === "admin") return true;
  const viaOrg = actor.orgRole ? ORG_MAP[actor.orgRole].includes(action) : false;
  const viaSite = actor.siteRole ? SITE_MAP[actor.siteRole].includes(action) : false;
  return viaOrg || viaSite;
}

/** The resolved capability set for an actor on THIS resource (M2): every verb `can()` grants, computed
 *  by ONE pass over ACTIONS through the SAME `can()` — so the list the console gates on can never drift
 *  from what the server enforces. Small by construction (only the true verbs) and ordered like ACTIONS.
 *  A platform admin gets the full set; a service token gets its scope-filtered set; an ordinary actor
 *  gets the union of its org + per-resource role grants. Powers `capabilities` on list/detail responses. */
export function capabilitiesFor(actor: Actor): Action[] {
  return ACTIONS.filter((a) => can(actor, a));
}

/** Who may create a resource IN an org (no resource exists yet, so this is an org-role check). */
export function canCreateInOrg(orgRole: OrgRole | null, platformRole: "admin" | "member"): boolean {
  return platformRole === "admin" || orgRole === "owner" || orgRole === "admin" || orgRole === "member";
}

/** Org-management roles allowed to administer an org's members/settings (not resource actions). */
export function canManageOrg(orgRole: OrgRole | null, platformRole: "admin" | "member"): boolean {
  return platformRole === "admin" || orgRole === "owner" || orgRole === "admin";
}
