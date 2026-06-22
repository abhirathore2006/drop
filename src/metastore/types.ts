import type { SiteConfig } from "../site-config.ts";
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

/** Per-publish audit metadata. */
export interface VersionMeta {
  id: string;
  publishedBy: string;
  createdAt: string; // ISO
  fileCount: number;
  bytes: number;
  config?: SiteConfig;
}

export class SiteNotFoundError extends Error {
  constructor(name: string) {
    super(`site not found: ${name}`);
    this.name = "SiteNotFoundError";
  }
}
