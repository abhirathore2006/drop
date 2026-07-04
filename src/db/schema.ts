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
// bucket (local) or a per-tenant prefix + scoped IAM policy (prod). `cache` (I2) is a managed
// single-replica Valkey (deliberately tiny, ephemeral by default). `auth` (K1) is a managed
// per-app auth resource — a GoTrue engine Deployment in the tenant namespace whose users live in
// the bound Postgres, reachable at `auth--<name>.<baseDomain>`. Every type reuses the shared name
// namespace, org ownership, roles, and audit.
export type WorkloadType = "site" | "app" | "database" | "bucket" | "cache" | "auth";

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

/** A workload's TCP exposure (A2b). One row per exposed workload (site_name PK). `mode` is 'sni'
 *  (routed by the TLS SNI hostname on a shared port — no port consumed) or 'port' (a dedicated port
 *  from the dynamic pool; `port` is set + UNIQUE for these, NULL for sni rows). `protocol` is a hint
 *  for the connect string / router preamble ('postgres' | 'redis' | 'tcp'). The edge-tcp router reads
 *  this read-only (MetastoreRouteSource); the API is the sole writer via the expose routes. */
export interface TcpEndpointsTable {
  site_name: string;
  port: number | null; // set + unique for mode='port'; null for mode='sni'
  mode: "sni" | "port";
  protocol: string; // 'postgres' | 'redis' | 'tcp'
  created_by: string;
  created_at: Generated<Ts>;
}

/** Service accounts / scoped CI tokens (J1). A long-lived bearer credential owned by an ORG (not a
 *  person): only its sha256 `token_hash` is stored (the secret is shown once at create). `scopes` is a
 *  jsonb array of `verb[:resource|:*]` strings validated against the permission verbs. Revocation is a
 *  SOFT mark (`revoked_at`) — the row stays for audit value; a revoked/expired token fails verify → 401.
 *  `last_used_at` is bumped throttled (~1/min) on use. Cascades on the owning org's delete. */
export interface ServiceTokensTable {
  id: string;
  org_id: string;
  name: string;
  scopes: ColumnType<string[], string, string>; // jsonb: JSON.stringify on write, parse at the store boundary
  token_hash: string; // sha256 hex of the full secret — the lookup key (never the secret itself)
  expires_at: Ts | null; // null = never expires
  created_by: string; // the human who minted it (audit)
  created_at: Ts; // set from the store's injectable clock (the column also has a now() default)
  last_used_at: Ts | null; // throttled last-use timestamp (~1/min)
  revoked_at: Ts | null; // soft revocation mark (null = live)
}

/** A publishable template (D1): a named, org-owned, visibility-scoped catalog entry. `slug` is UNIQUE
 *  instance-wide (the golden-path namespace). `visibility` is 'public' (instance-wide) | 'org' (members
 *  only). Its published versions live in `template_versions`. */
export interface TemplatesTable {
  id: string;
  slug: string;
  org_id: string;
  name: string;
  description: string | null;
  visibility: ColumnType<TemplateVisibility, TemplateVisibility | undefined, TemplateVisibility>;
  created_by: string;
  created_at: Generated<Ts>;
}

export type TemplateVisibility = "public" | "org";

/** jsonb template spec (a sanitized, stripped StackSpec) + jsonb variable declarations. */
type JsonTemplateSpec = ColumnType<StackSpec, string, string>;

/** One immutable published version of a template (D1). `version` is a monotonic integer-as-text. `spec`
 *  is the template-relative stack spec; `variables` is the TemplateVariable[] declaration array. */
export interface TemplateVersionsTable {
  template_id: string;
  version: string;
  spec: JsonTemplateSpec;
  variables: ColumnType<unknown[], string, string>; // jsonb TemplateVariable[]: stringify on write, parse at store boundary
  readme: string | null;
  created_by: string;
  created_at: Generated<Ts>;
}

/** A labeled, expiring preview of a SPECIFIC version (E1), served at `<site>--<label>.<baseDomain>`
 *  alongside (never instead of) the parent's `current_version`. PK (site_name, label) — republishing
 *  the same label re-points it at a new version (the API upserts). `version_id` deliberately carries
 *  NO foreign key to `versions`: the existing publish-time pruneVersions/GC may reap an old version's
 *  bytes+row before its preview's OWN `expires_at` passes — accepted, documented behavior (see
 *  docs/previews.html), not new cross-feature protection. Cascades on the owning site's delete. */
export interface PreviewsTable {
  site_name: string;
  label: string;
  version_id: string;
  created_by: string;
  created_at: Ts; // set from the store's injectable clock (the column also has a now() default)
  expires_at: Ts;
}

/** A short-lived, single-use tunnel ticket (A3, `db:proxy`). Issued by `POST
 *  /v1/databases/:name/tunnel-ticket` (authz `connect`) and redeemed ONCE by the WebSocket tunnel
 *  upgrade. Only the sha256 `token_hash` is stored — the raw `drop_tt_…` secret is returned once and
 *  never persisted, so a leaked metastore yields no usable ticket. `used_at` flips non-null on
 *  redemption (the single-use latch, set by a conditional UPDATE); the ticket is bound to `site_name`
 *  (the database) + `email` (the user) so a ticket for one DB can't open another. `expires_at` is a
 *  60s TTL. Cascades on the owning database's delete. */
export interface TunnelTicketsTable {
  id: string;
  token_hash: string; // sha256 hex of the full `drop_tt_…` secret — the lookup key (never the secret)
  site_name: string; // the workload this ticket authorizes: a database (tunnel) or an app (exec)
  email: string; // the user the ticket was issued to (the audited actor at redemption)
  expires_at: Ts; // 60s TTL from issuance (injectable clock)
  used_at: Ts | null; // null = unredeemed; set once at redemption (single-use latch)
  created_at: Ts; // set from the store's injectable clock (the column also has a now() default)
  kind: ColumnType<TicketKind, TicketKind | undefined, TicketKind>; // (J3) 'tunnel' (A3) | 'exec' (J3); db-default 'tunnel'
  command: ColumnType<string[] | null, string | null | undefined, string | null>; // (J3) exec argv bound at issue (json); null for a tunnel
}

/** A ticket's kind (J3): `tunnel` is the A3 db:proxy psql splice; `exec` is the J3 shell bridge. */
export type TicketKind = "tunnel" | "exec";

/** Per-host edge traffic rollup (G2). One row per (site_name, minute) — the edge accumulates
 *  requests/bytes/status-classes/latency in-process and UPSERTs additively every ~15s. `site_name` is
 *  the resolved serving HOST (a site name, or a preview `site--label`), not FK-bound to `sites`.
 *  `requests`/`bytes_*` are bigint (a busy minute can exceed int4 bytes); the percentile fields are
 *  approximations (see MetricsStore.flushTraffic for the merge honesty note). 30d retention, swept. */
export interface TrafficMinutesTable {
  site_name: string;
  minute: ColumnType<Date, Date | string, Date | string>;
  requests: ColumnType<number, number | bigint, number | bigint>;
  bytes_in: ColumnType<number, number | bigint, number | bigint>;
  bytes_out: ColumnType<number, number | bigint, number | bigint>;
  p50_ms: number;
  p95_ms: number;
  s2xx: number;
  s4xx: number;
  s5xx: number;
}

/** Synthetic uptime-check rollup (G2b). One row per (site_name, minute), last-write-wins — the API
 *  poller probes each qualifying workload on an interval and records the outcome. `site_name` is
 *  always a live site (cascades on its delete). `status` is the probe's HTTP status, or 0 for a
 *  TCP-connect probe (a database). 30d retention, swept alongside `traffic_minutes`. */
export interface UptimeChecksTable {
  site_name: string;
  minute: ColumnType<Date, Date | string, Date | string>;
  ok: boolean;
  latency_ms: number;
  status: number;
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
  tcp_endpoints: TcpEndpointsTable;
  service_tokens: ServiceTokensTable;
  templates: TemplatesTable;
  template_versions: TemplateVersionsTable;
  previews: PreviewsTable;
  tunnel_tickets: TunnelTicketsTable;
  traffic_minutes: TrafficMinutesTable;
  uptime_checks: UptimeChecksTable;
}
