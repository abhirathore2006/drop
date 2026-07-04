import type { ColumnType, Generated } from "kysely";
import type { SiteConfig } from "../site-config.ts";
import type { StackSpec } from "../stack-config.ts";

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
// The `sites` discriminator. `bucket` (I1) is tenant object storage — a prefix in the platform S3
// bucket (local) or a per-tenant prefix + scoped IAM policy (prod). It reuses the shared name
// namespace, org ownership, roles, and audit like every other type. (cache/auth land later.)
export type WorkloadType = "site" | "app" | "database" | "bucket";

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

/** jsonb stack spec: JSON.stringify on write, JSON.parse on read at the store boundary. */
type JsonStackSpec = ColumnType<StackSpec, string, string>;

/** A stack: a declarative multi-resource group + its desired-state spec (B2). Name unique per org. */
export interface StacksTable {
  id: string;
  name: string;
  org_id: string;
  spec: JsonStackSpec;
  spec_version: ColumnType<number, number | undefined, number>;
  from_template: string | null;
  from_template_version: string | null;
  created_by: string;
  created_at: Generated<Ts>;
  updated_at: Ts;
}

/** Maps a stack resource KEY to the site name it materialized as (`<stack>-<key>` or an override). */
export interface StackResourcesTable {
  stack_id: string;
  resource_key: string;
  site_name: string;
}

/** Per-org quota OVERRIDES (Future.md item 10). One row per (org, key); the value is stored as text
 *  (a k8s quantity like "5Gi", or an integer as a string) and parsed at the enforcement point. An
 *  absent row means "use the platform default" (config / MAX_DB_STORAGE). Keys v1: `max_workloads`,
 *  `max_db_storage` (per-database PVC cap), `storage_budget_bytes` (org-wide storage budget). */
export interface OrgQuotasTable {
  org_id: string;
  key: string;
  value: string;
  updated_by: string;
  updated_at: Generated<Ts>;
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
  stacks: StacksTable;
  stack_resources: StackResourcesTable;
  org_quotas: OrgQuotasTable;
}
