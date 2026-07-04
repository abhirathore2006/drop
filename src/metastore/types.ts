import type { SiteConfig } from "../site-config.ts";
import type { AppConfig } from "../app-config.ts";
import type { DatabaseConfig } from "../db-config.ts";
import type { CacheConfig } from "../cache-config.ts";
import type { RuntimeState, SiteRole, Visibility, WorkloadType } from "../db/schema.ts";

export type { Visibility, WorkloadType, RuntimeState };

export interface Member {
  email: string;
  role: SiteRole;
}

/** The per-site record (sites row + reconstructed membership). */
export interface Site {
  name: string;
  type: WorkloadType; // "site" (static) or "app" (container workload)
  owner: string; // email of the role='owner' member
  collaborators: string[]; // editor + viewer emails (back-compat shape)
  members: Member[]; // full membership incl. owner
  currentVersion: string | null;
  visibility: Visibility;
  runtimeState: RuntimeState; // "running" | "stopped" (apps; stop/start lifecycle)
  orgId: string | null; // owning organisation (null only in the migration window)
  namespace: string; // the resolved tenant namespace (org's namespace, or owner-derived fallback)
  config?: SiteConfig; // current version's parsed drop.yaml (denormalized for the edge)
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** A secret KEY's metadata — never the value. */
export interface SecretKeyMeta {
  key: string;
  fingerprint: string;
  updatedBy: string;
  updatedAt: string; // ISO
}

/** Lean record for the edge hot path (no member list). */
export interface SitePointer {
  type: WorkloadType; // edge dispatches: "site" -> S3 bytes, "app" -> proxy to cluster
  currentVersion: string | null;
  visibility: Visibility;
  passwordHash: string | null;
  config?: SiteConfig;
}

/** Per-publish audit metadata. `config` is the site's parsed drop.yaml for a static-site publish,
 *  or (H1) the full sanitized AppConfig — including the resolved image ref — for an app deploy;
 *  the latter is what makes app rollback possible (re-apply a prior version's stored config). A
 *  version recorded before H1 shipped has no `config` and cannot be rolled back to. For a database
 *  (I1/item 10) it's the sanitized DatabaseConfig, so the org storage budget can read its requested
 *  PVC size back. */
export interface VersionMeta {
  id: string;
  publishedBy: string;
  createdAt: string; // ISO
  fileCount: number;
  bytes: number;
  config?: SiteConfig | AppConfig | DatabaseConfig | CacheConfig;
}

export class SiteNotFoundError extends Error {
  constructor(name: string) {
    super(`site not found: ${name}`);
    this.name = "SiteNotFoundError";
  }
}
