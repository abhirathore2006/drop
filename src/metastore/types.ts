import type { SiteConfig } from "../site-config.ts";

/** The per-site record, stored at sites/<name>/site.json. */
export interface Site {
  name: string;
  owner: string; // verified email
  collaborators: string[]; // verified emails
  currentVersion: string | null;
  config?: SiteConfig; // the current version's parsed _drop.json (denormalized for the edge)
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Per-publish audit metadata, stored at sites/<name>/versions/<id>.json (immutable). */
export interface VersionMeta {
  id: string;
  publishedBy: string;
  createdAt: string; // ISO
  fileCount: number;
  bytes: number;
  config?: SiteConfig; // parsed _drop.json captured at this publish
}

export class SiteNotFoundError extends Error {
  constructor(name: string) {
    super(`site not found: ${name}`);
    this.name = "SiteNotFoundError";
  }
}
