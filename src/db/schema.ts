import type { ColumnType, Generated } from "kysely";
import type { SiteConfig } from "../site-config.ts";

/** timestamptz: read as Date, write as Date|string, default-insertable. */
type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
/** jsonb config: we JSON.stringify on write, JSON.parse on read at the store boundary. */
type JsonConfig = ColumnType<SiteConfig | null, string | null, string | null>;

export interface UsersTable {
  email: string;
  name: string | null;
  role: ColumnType<"admin" | "member", "admin" | "member" | undefined, "admin" | "member">;
  status: ColumnType<"active" | "suspended", "active" | "suspended" | undefined, "active" | "suspended">;
  created_at: Generated<Ts>;
  last_login_at: Ts | null;
}

export type Visibility = "public" | "private" | "password";
export type WorkloadType = "site" | "app" | "database";

export interface SitesTable {
  name: string;
  type: ColumnType<WorkloadType, WorkloadType | undefined, WorkloadType>;
  current_version: string | null;
  visibility: ColumnType<Visibility, Visibility | undefined, Visibility>;
  password_hash: string | null;
  config: JsonConfig;
  runtime_state: ColumnType<RuntimeState, RuntimeState | undefined, RuntimeState>;
  org_id: string | null; // owning organisation (nullable through the orgs migration window)
  created_at: Generated<Ts>;
  updated_at: Ts;
}

export type OrgRole = "owner" | "admin" | "member" | "viewer";
export type OrgKind = "personal" | "team";

export interface OrganisationsTable {
  id: string;
  slug: string;
  name: string;
  kind: ColumnType<OrgKind, OrgKind, OrgKind>;
  namespace: string; // the literal k8s tenant namespace (stored, not re-derived)
  created_by: string;
  created_at: Generated<Ts>;
}

export interface OrgMembersTable {
  org_id: string;
  email: string;
  role: OrgRole;
  created_at: Generated<Ts>;
}

export type RuntimeState = "running" | "stopped";

export interface AppSecretKeysTable {
  app: string;
  key: string;
  fingerprint: string;
  updated_by: string;
  updated_at: Generated<Ts>;
}

export type SiteRole = "owner" | "editor" | "viewer";

export interface SiteMembersTable {
  site_name: string;
  email: string;
  role: SiteRole;
  created_at: Generated<Ts>;
}

export interface VersionsTable {
  site_name: string;
  id: string;
  published_by: string;
  created_at: Ts;
  file_count: number;
  bytes: ColumnType<number, number | bigint, number | bigint>;
  config: JsonConfig;
}

type HandleStatus = "pending" | "done" | "denied";

export interface AuthHandlesTable {
  id: string;
  poll_token: string;
  code_verifier: string;
  status: ColumnType<HandleStatus, HandleStatus | undefined, HandleStatus>;
  mode: "cli" | "browser";
  token: string | null;
  error: string | null;
  created_at: Generated<Ts>;
}

/** Append-only audit trail of mutating/admin actions. id is a bigserial (returned as a
 *  string by the pg driver) — monotonic, so it doubles as the keyset-pagination cursor. */
export interface AuditLogTable {
  id: Generated<string>;
  at: Generated<Ts>;
  actor: string; // who performed the action (lowercased email)
  action: string; // e.g. "site.delete", "user.role.set", "db.password.rotate"
  target: string | null; // the resource/user acted upon
  target_type: string | null; // "site" | "app" | "database" | "user" | "org"
  org_id: string | null; // owning org of the target resource, when applicable
  detail: ColumnType<Record<string, unknown> | null, string | null, string | null>; // extra context (jsonb)
}

/** Lease-based advisory lock: one row per key, stolen when `expires_at` passes (see LockStore). */
export interface LocksTable {
  key: string;
  holder: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

export interface Database {
  users: UsersTable;
  audit_log: AuditLogTable;
  sites: SitesTable;
  site_members: SiteMembersTable;
  versions: VersionsTable;
  auth_handles: AuthHandlesTable;
  app_secret_keys: AppSecretKeysTable;
  organisations: OrganisationsTable;
  org_members: OrgMembersTable;
  locks: LocksTable;
}
