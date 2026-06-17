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

export interface SitesTable {
  name: string;
  current_version: string | null;
  visibility: ColumnType<Visibility, Visibility | undefined, Visibility>;
  password_hash: string | null;
  config: JsonConfig;
  created_at: Generated<Ts>;
  updated_at: Ts;
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

export interface AuthHandlesTable {
  id: string;
  poll_token: string;
  code_verifier: string;
  status: ColumnType<"pending" | "done", "pending" | "done" | undefined, "pending" | "done">;
  mode: "cli" | "browser";
  token: string | null;
  created_at: Generated<Ts>;
}

export interface Database {
  users: UsersTable;
  sites: SitesTable;
  site_members: SiteMembersTable;
  versions: VersionsTable;
  auth_handles: AuthHandlesTable;
}
