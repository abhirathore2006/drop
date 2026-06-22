import type { OrgRole, SiteRole } from "../db/schema.ts";

export type Action = "read" | "logs" | "publish" | "deploy" | "db:create" | "rollback" | "configure" | "share" | "transfer" | "delete";

export interface Actor {
  email: string;
  platformRole: "admin" | "member";
  siteRole: SiteRole | null; // null = not a per-resource member of this site
  orgRole: OrgRole | null; // role in the RESOURCE's owning org (null = not an org member)
}

// read = see the workload in the dashboard / its versions & settings.
// logs = read pod logs — gated ABOVE viewer: logs can contain env-injected secrets, and a
//   viewer is deliberately metadata-only (it never sees the credentials Secret).
// publish = ship a static-site version; deploy = ship a container-app revision.
// db:create = provision/update a managed database. configure = set visibility / password / secrets.
const SITE_MAP: Record<SiteRole, Action[]> = {
  owner: ["read", "logs", "publish", "deploy", "db:create", "rollback", "configure", "share", "transfer", "delete"],
  editor: ["read", "logs", "publish", "deploy", "db:create", "rollback"],
  viewer: ["read"],
};

// Org roles apply org-WIDE (every resource in the org). owner/admin manage everything; member is the
// day-to-day (ship + configure/secrets, but not share/transfer/delete a resource); viewer reads.
const ORG_MAP: Record<OrgRole, Action[]> = {
  owner: ["read", "logs", "publish", "deploy", "db:create", "rollback", "configure", "share", "transfer", "delete"],
  admin: ["read", "logs", "publish", "deploy", "db:create", "rollback", "configure", "share", "transfer", "delete"],
  member: ["read", "logs", "publish", "deploy", "db:create", "rollback", "configure"],
  viewer: ["read"],
};

/** The single authority check. Platform admins are all-powerful; otherwise the UNION of the actor's
 *  org-wide role and any per-resource grant (so the broader of the two wins, never the narrower). */
export function can(actor: Actor, action: Action): boolean {
  if (actor.platformRole === "admin") return true;
  const viaOrg = actor.orgRole ? ORG_MAP[actor.orgRole].includes(action) : false;
  const viaSite = actor.siteRole ? SITE_MAP[actor.siteRole].includes(action) : false;
  return viaOrg || viaSite;
}

/** Who may create a resource IN an org (no resource exists yet, so this is an org-role check). */
export function canCreateInOrg(orgRole: OrgRole | null, platformRole: "admin" | "member"): boolean {
  return platformRole === "admin" || orgRole === "owner" || orgRole === "admin" || orgRole === "member";
}

/** Org-management roles allowed to administer an org's members/settings (not resource actions). */
export function canManageOrg(orgRole: OrgRole | null, platformRole: "admin" | "member"): boolean {
  return platformRole === "admin" || orgRole === "owner" || orgRole === "admin";
}
