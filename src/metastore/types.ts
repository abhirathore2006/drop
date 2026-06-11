/** The per-site record, stored at sites/<name>/site.json. */
export interface Site {
  name: string;
  owner: string; // verified email
  collaborators: string[]; // verified emails
  currentVersion: string | null;
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
}

export class SiteNotFoundError extends Error {
  constructor(name: string) {
    super(`site not found: ${name}`);
    this.name = "SiteNotFoundError";
  }
}
