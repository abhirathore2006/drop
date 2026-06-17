import type { SiteRole } from "../db/schema.ts";

export type Action = "read" | "publish" | "rollback" | "configure" | "share" | "transfer" | "delete";

export interface Actor {
  email: string;
  platformRole: "admin" | "member";
  siteRole: SiteRole | null; // null = not a member of this site
}

// read = see the site in the dashboard / its versions & settings.
// configure = set visibility / password.
const MAP: Record<SiteRole, Action[]> = {
  owner: ["read", "publish", "rollback", "configure", "share", "transfer", "delete"],
  editor: ["read", "publish", "rollback"],
  viewer: ["read"],
};

/** The single authority check. Platform admins are all-powerful on every site. */
export function can(actor: Actor, action: Action): boolean {
  if (actor.platformRole === "admin") return true;
  if (!actor.siteRole) return false;
  return MAP[actor.siteRole].includes(action);
}
