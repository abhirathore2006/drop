import type { Site } from "../metastore/types.ts";

/** Owner-only: share/unshare, transfer, delete. */
export function canAdmin(site: Site, email: string): boolean {
  return site.owner === email;
}

/** Write: publish + rollback (owner or collaborator). */
export function canWrite(site: Site, email: string): boolean {
  return site.owner === email || site.collaborators.includes(email);
}

/** Platform admin (DROP_ADMINS) — may list/manage all sites. */
export function isAdmin(email: string, admins: string[]): boolean {
  return admins.includes(email.toLowerCase());
}
