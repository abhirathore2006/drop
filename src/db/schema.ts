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

export interface Database {
  users: UsersTable;
  sites: SitesTable;
  site_members: SiteMembersTable;
  versions: VersionsTable;
  auth_handles: AuthHandlesTable;
  app_secret_keys: AppSecretKeysTable;
  organisations: OrganisationsTable;
  org_members: OrgMembersTable;
}
