// Typed client for the Drop control-plane API. Same-origin fetch carries the session cookie.
// Errors are thrown as ApiError so callers (and the query layer's 401 interceptor) can
// branch on status.

export type WorkloadType = "site" | "app" | "database" | "bucket" | "cache" | "auth";

/** The permission verbs (M2) — mirrors src/authz/permissions.ts ACTIONS. `capabilities` on a list item
 *  or detail response is the resolved subset the CURRENT actor holds on that resource; the console gates
 *  purely on this (via lib/caps.ts), never re-deriving permissions from owner/role math. */
export type Capability =
  | "read"
  | "logs"
  | "publish"
  | "deploy"
  | "db:create"
  | "connect"
  | "query" // (I4) run a read-only SQL query — editor+ (above viewer); gates the DB SQL-console panel
  | "rollback"
  | "configure"
  | "expose"
  | "share"
  | "transfer"
  | "delete";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface Me {
  email: string;
  admin: boolean;
}

export interface AdminUser {
  email: string;
  name: string | null;
  role: "admin" | "member";
  status: "active" | "suspended";
}

export interface AdminOrg {
  slug: string;
  name: string;
  kind: string; // "personal" | "team"
  owner: string;
}

export interface OrgUsage {
  org: { slug: string; name: string; kind: string };
  workloads: { site: number; app: number; database: number; bucket: number; cache: number; auth: number; total: number };
  cap: number; // 0 = unlimited
  quota: { hard: Record<string, string>; used: Record<string, string> } | null;
  storage?: {
    databases: { count: number; requestedBytes: number };
    buckets: { count: number; bytes: number };
    caches: { count: number; bytes: number }; // (I2) persistent-cache PVC requests
    budget: number | null; // null = no budget configured
  };
}

/** (M2 / item 10) Per-org quota overrides as returned by GET /v1/admin/orgs/:slug/quotas.
 *  `overrides` are the raw, explicitly-set values; `effective` folds each override over the instance
 *  default (so an unset key still shows what's enforced — the "default hint" in the editor). */
export interface AdminQuotas {
  org: { slug: string; name: string };
  keys: string[]; // the settable keys: max_workloads, max_db_storage, storage_budget_bytes
  overrides: { key: string; value: string; updatedBy: string; updatedAt: string }[];
  effective: { max_workloads: number; max_db_storage: string; storage_budget_bytes: number | null };
}

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  targetType: string | null;
  orgId: string | null;
  detail: Record<string, unknown> | null;
}

export interface Org {
  slug: string;
  name: string;
  kind: string; // "personal" | "team"
}

/** Server-computed status (M0 status contract). Optional until the API starts sending it;
 *  lib/status.ts falls back to deriving the same enum from the raw fields. */
export interface ServerStatus {
  status: string;
  reason: string;
}

export interface ListItem {
  name: string;
  type: WorkloadType;
  owner: string;
  org?: Org | null;
  visibility: string;
  url: string;
  current: string | null;
  collaborators?: number;
  status?: ServerStatus | null;
  capabilities?: Capability[]; // (M2) the caller's resolved verbs on this resource
}

export interface AppStatus {
  replicas: number;
  ready: number;
  restarts: number;
  reason: string;
}
export interface DatabaseStatus {
  phase: string;
  ready: number;
  instances: number;
  hibernated: boolean;
}
export interface BackupInfo {
  name: string;
  phase: string;
  method: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  error: string | null;
}
export interface BucketInfo {
  endpoint: string;
  bucket: string;
  prefix: string;
  bytes: number;
  objects: number;
}
/** (I2) A managed cache's connection info + live status. Never carries the password. */
export interface CacheInfo {
  host: string;
  port: number;
  memory: string;
  persistent: boolean;
  status: AppStatus | null;
}
/** (K1) A managed auth resource's config surface + live status. NEVER carries key material. */
export interface AuthInfo {
  url: string;
  engine: string; // "gotrue"
  jwtAlg: string; // "HS256"
  db: string | null; // the bound database name
  signup: string; // "open" | "closed"
  providers: string[]; // enabled provider kinds
  redirectUrls: string[];
  jwtTtl: string;
  keyMintedAt: string | null; // when the JWT secret was last (re)minted (drives "key age") — NOT the key
  status: AppStatus | null;
}
/** (K1) An end user as returned by the user-admin proxy (GoTrue's admin shape, loosely typed). */
export interface AuthUser {
  id: string;
  email?: string;
  banned_until?: string | null;
  created_at?: string;
}
/** (I3) A database's connection-pooler state. */
export interface PoolerInfo {
  enabled: boolean;
  mode?: string; // "transaction" | "session"
  host?: string;
}
/** (I4) A read-only SQL-console result. `rows` are positional (aligned to `columns`). `truncated` is
 *  true when the 500-row / ~1MB cap clipped the result. */
export interface SqlColumn {
  name: string;
}
export interface SqlQueryResult {
  columns: SqlColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}
export interface Version {
  id: string;
  publishedBy: string;
  createdAt: string;
  fileCount: number;
  bytes: number;
}
/** (E1) A labeled, expiring preview of a specific version, served at <site>--<label>.<baseDomain>. */
export interface PreviewInfo {
  label: string;
  versionId: string;
  url: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}
export interface SecretMeta {
  key: string;
  fingerprint: string;
  updatedBy: string;
  updatedAt: string;
}
/** (A2b) A workload's TCP (L4) exposure state, present on the detail response iff it's exposed. */
export interface TcpExposure {
  mode: "sni" | "port";
  port: number | null;
  protocol: string; // 'postgres' | 'redis' | 'tcp'
  connect: string; // the connect string (host:port)
  sslmode?: string; // an sslmode hint for postgres
}

/** (G2b) The most recent synthetic uptime check. `status` is the HTTP status, or 0 for a TCP probe. */
export interface UptimeLastCheck {
  ok: boolean;
  latencyMs: number;
  status: number;
  at: string; // ISO
}
/** (G2b) Uptime summary on the detail response: last-24h OK % (null when no checks) + the latest check. */
export interface UptimeSummary {
  last24hPct: number | null;
  lastCheck: UptimeLastCheck | null;
}
/** (G2) One aggregated traffic point (M4 renders these as a sparkline; v1 shows totals only). */
export interface MetricsSeriesPoint {
  minute: string;
  requests: number;
  p50: number;
  p95: number;
  errors: number;
  bytesOut: number;
}
export interface MetricsTotals {
  requests: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  p50: number;
  p95: number;
}
export interface SiteMetrics {
  range: string;
  series: MetricsSeriesPoint[];
  totals: MetricsTotals;
}

export interface Detail {
  name: string;
  type: WorkloadType;
  owner: string;
  org?: Org | null;
  collaborators: string[];
  members: { email: string; role: string }[];
  visibility: string;
  current: string | null;
  url: string;
  versions: Version[];
  capabilities?: Capability[]; // (M2) the caller's resolved verbs on this resource — the console gates on this
  previews?: PreviewInfo[]; // (E1) active previews — present for type=site only
  status?: ServerStatus | null;
  uptime?: UptimeSummary; // (G2b) present for site/app/database
  tcp?: TcpExposure; // (A2b) present when the app/database is TCP-exposed
  app?: {
    image: string | null;
    scale: { min: number; max: number } | null;
    resources?: { cpu?: string; memory?: string } | null;
    status: AppStatus | null;
    runtimeState?: "running" | "stopped";
  };
  database?: {
    host: string;
    port: number;
    database: string;
    user: string;
    credentialsSecret: string;
    status: DatabaseStatus | null;
    extensions?: string[]; // (I3) extensions created at bootstrap (from the stored config)
    pooler?: PoolerInfo; // (I3) connection-pooler state
  };
  bucket?: BucketInfo;
  cache?: CacheInfo; // (I2) present for type=cache
  auth?: AuthInfo; // (K1) present for type=auth
}

// ---- Stacks (B2/C1) ----
export interface StackListItem {
  name: string;
  org?: Org | null;
  specVersion: number;
  resources: number; // resource count
  fromTemplate: string | null;
  updatedAt: string;
}

/** One node of the stack graph (GET /v1/stacks/:name/graph). `status` is the server-computed
 *  normalized status contract (src/api/status.ts). */
export interface GraphNode {
  key: string;
  siteName: string;
  type: WorkloadType;
  url: string;
  currentVersion: string | null;
  exists: boolean;
  status: ServerStatus;
}
export interface GraphEdge {
  from: string; // resource KEY (provider)
  to: string; // resource KEY (consumer)
  kind: "uses" | "env_from";
  label: string;
}
/** A pending plan step in the graph overlay (?include_plan). Mirrors src/stacks/plan.ts PlanStep. */
export interface GraphPlanStep {
  action: "create" | "update" | "delete" | "noop";
  key: string;
  kind: WorkloadType;
  siteName: string;
  reason: string;
}
export interface StackGraph {
  name: string;
  org?: Org | null;
  specVersion: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  plan?: GraphPlanStep[]; // present only with ?include_plan; already filtered to non-noop steps
}

// ---- Templates (D1) ----
export interface TemplateVariable {
  key: string;
  description?: string;
  default?: string;
  required: boolean;
  secret?: boolean;
}
export interface TemplateListItem {
  slug: string;
  name: string;
  description: string | null;
  visibility: "public" | "org";
  org?: Org | null;
  latestVersion: string | null;
  resources: number;
  createdAt: string;
}
/** A template resource — a loose union over the stack resource kinds (only the fields the preview reads). */
export interface TemplateResource {
  type: WorkloadType;
  name?: string;
  image?: string;
  dir?: string;
  env?: Record<string, string>;
  uses?: { database?: string; bucket?: string; cache?: string; auth?: string }[];
  env_from?: { resource: string; as: string; output: string }[];
  storage?: string;
}
export interface TemplateSpec {
  name: string;
  resources: Record<string, TemplateResource>;
}
export interface TemplateDetail {
  slug: string;
  name: string;
  description: string | null;
  visibility: "public" | "org";
  org?: Org | null;
  version: string;
  versions: string[];
  variables: TemplateVariable[];
  readme: string | null;
  spec: TemplateSpec;
}
export interface InstantiateResult {
  stack: string;
  version: string;
  specVersion: number;
  plan: GraphPlanStep[];
  secretsToSet: { app: string; resourceKey: string; key: string; value: string }[];
  needs?: { key: string; kind: string; siteName: string }[];
}

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: string }).error ?? `${path}: ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return json as T;
}

export const api = {
  me: () => req<Me>("GET", "/v1/me"),
  list: () => req<{ sites: ListItem[] }>("GET", "/v1/sites"),
  adminList: (qs: string) => req<{ sites: ListItem[]; nextCursor?: string }>("GET", "/v1/admin/sites" + (qs ? `?${qs}` : "")),
  get: (name: string) => req<Detail>("GET", `/v1/sites/${name}`),
  // (G2/G2b) edge request metrics (window totals + series) + the uptime strip (M4 renders charts).
  metrics: (name: string, range: "1h" | "24h" | "7d" = "1h") => req<SiteMetrics>("GET", `/v1/sites/${name}/metrics?range=${range}`),
  uptime: (name: string) => req<{ range: string; checks: UptimeLastCheck[]; summary: UptimeSummary }>("GET", `/v1/sites/${name}/uptime`),
  logs: (name: string) => req<{ logs: string }>("GET", `/v1/sites/${name}/logs?tail=200`),
  rollback: (name: string, to: string) => req("POST", `/v1/sites/${name}/rollback`, { to }),
  setVisibility: (name: string, visibility: string, password?: string) =>
    req("POST", `/v1/sites/${name}/visibility`, { visibility, password }),
  setDbPassword: (name: string) =>
    req<{ name: string; user: string; password: string; warning?: string }>("POST", `/v1/databases/${name}/password`, {}),
  dbBackups: (name: string) => req<{ backups: BackupInfo[]; lastSuccessAt: string | null }>("GET", `/v1/databases/${name}/backups`),
  triggerDbBackup: (name: string) => req<{ backup: string }>("POST", `/v1/databases/${name}/backups`, {}),
  hibernateDb: (name: string) => req("POST", `/v1/databases/${name}/hibernate`, {}),
  wakeDb: (name: string) => req("POST", `/v1/databases/${name}/wake`, {}),
  // (I3) connection pooling — enable emits a CNPG Pooler; disable deletes it.
  setDbPooler: (name: string, enable: boolean, mode?: "transaction" | "session") =>
    req<{ name: string; pooler: PoolerInfo }>("POST", `/v1/databases/${name}/pooler`, { enable, ...(mode ? { mode } : {}) }),
  // (I4) SQL console — a READ-ONLY query (session-enforced read-only, audited, 5s timeout, 500-row cap).
  dbQuery: (name: string, sql: string) => req<SqlQueryResult>("POST", `/v1/databases/${name}/query`, { sql }),
  rotateBucket: (name: string) =>
    req<{ name: string; endpoint: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string }>("POST", `/v1/buckets/${name}/rotate`, {}),
  // (K1) managed auth resource — user-admin proxy + key rotation. Never returns key material.
  authUsers: (name: string) => req<{ users?: AuthUser[]; aud?: string }>("GET", `/v1/auths/${name}/users`),
  createAuthUser: (name: string, email: string) => req<{ id?: string; tempPassword?: string }>("POST", `/v1/auths/${name}/users`, { email }),
  removeAuthUser: (name: string, id: string) => req("DELETE", `/v1/auths/${name}/users/${encodeURIComponent(id)}`),
  disableAuthUser: (name: string, id: string, disable: boolean) => req("POST", `/v1/auths/${name}/users/${encodeURIComponent(id)}/disable`, { disable }),
  rotateAuthKeys: (name: string) => req<{ name: string; rotated: boolean; grace: boolean }>("POST", `/v1/auths/${name}/rotate-keys`, {}),
  addCollaborator: (name: string, email: string) => req("POST", `/v1/sites/${name}/collaborators`, { email }),
  removeCollaborator: (name: string, email: string) => req("DELETE", `/v1/sites/${name}/collaborators/${encodeURIComponent(email)}`),
  transfer: (name: string, email: string) => req("POST", `/v1/sites/${name}/transfer`, { email }),
  remove: (name: string, force?: boolean) => req("DELETE", `/v1/sites/${name}${force ? "?force=1" : ""}`),
  setUserStatus: (email: string, status: "active" | "suspended") =>
    req("POST", `/v1/admin/users/${encodeURIComponent(email)}/status`, { status }),
  adminUsers: () => req<{ users: AdminUser[] }>("GET", "/v1/admin/users"),
  setUserRole: (email: string, role: "admin" | "member") => req("POST", `/v1/admin/users/${encodeURIComponent(email)}/role`, { role }),
  adminOrgs: () => req<{ orgs: AdminOrg[] }>("GET", "/v1/admin/orgs"),
  adminAudit: (qs: string) => req<{ entries: AuditRecord[]; nextCursor?: string }>("GET", "/v1/admin/audit" + (qs ? `?${qs}` : "")),
  // (M2 / item 10) per-org quota editor — read the overrides+effective values, then set one or more keys.
  adminOrgQuotas: (slug: string) => req<AdminQuotas>("GET", `/v1/admin/orgs/${encodeURIComponent(slug)}/quotas`),
  setAdminOrgQuotas: (slug: string, quotas: Record<string, string>) =>
    req<{ org: string; set: Record<string, string> }>("PUT", `/v1/admin/orgs/${encodeURIComponent(slug)}/quotas`, { quotas }),
  orgUsage: (slug: string) => req<OrgUsage>("GET", `/v1/orgs/${encodeURIComponent(slug)}/usage`),
  // app secrets (write-only) + lifecycle
  listSecrets: (name: string) => req<{ secrets: SecretMeta[] }>("GET", `/v1/apps/${name}/secrets`),
  setSecret: (name: string, key: string, value: string) => req("PUT", `/v1/apps/${name}/secrets/${encodeURIComponent(key)}`, { value }),
  deleteSecret: (name: string, key: string) => req("DELETE", `/v1/apps/${name}/secrets/${encodeURIComponent(key)}`),
  restartApp: (name: string) => req("POST", `/v1/apps/${name}/restart`, {}),
  stopApp: (name: string) => req("POST", `/v1/apps/${name}/stop`, {}),
  startApp: (name: string) => req("POST", `/v1/apps/${name}/start`, {}),
  // previews (E1) — creation is CLI/CI only this round (see SitePanels.tsx's E2 note); the console
  // lists + removes them.
  removePreview: (name: string, label: string) =>
    req<{ removed: boolean; name: string; label: string }>("DELETE", `/v1/sites/${name}/previews/${encodeURIComponent(label)}`),
  // TCP (L4) exposure (A2b)
  expose: (name: string, mode: "sni" | "port", protocol?: string) =>
    req<{ name: string; tcp: TcpExposure; note?: string }>("POST", `/v1/sites/${name}/expose`, { mode, ...(protocol ? { protocol } : {}) }),
  unexpose: (name: string) => req<{ name: string; tcp: null; note?: string }>("DELETE", `/v1/sites/${name}/expose`),
  // stacks (B2/C1)
  stacks: () => req<{ stacks: StackListItem[] }>("GET", "/v1/stacks"),
  stackGraph: (name: string) => req<StackGraph>("GET", `/v1/stacks/${encodeURIComponent(name)}/graph?include_plan=1`),
  // templates (D1)
  templates: () => req<{ templates: TemplateListItem[] }>("GET", "/v1/templates"),
  template: (slug: string, version?: string) => req<TemplateDetail>("GET", `/v1/templates/${encodeURIComponent(slug)}${version ? `?version=${encodeURIComponent(version)}` : ""}`),
  instantiate: (slug: string, body: { name: string; org?: string; vars: Record<string, string>; version?: string }) =>
    req<InstantiateResult>("POST", `/v1/templates/${encodeURIComponent(slug)}/instantiate`, body),
};

/**
 * Build a read-only C1 StackGraph from a template spec — NODES ONLY, no live status (a preview never
 * polls the cluster). Edges mirror the server graph: db→app via `uses`, app→site via `env_from`.
 */
export function templatePreviewGraph(spec: TemplateSpec): StackGraph {
  const nodes: GraphNode[] = Object.entries(spec.resources).map(([key, res]) => ({
    key,
    siteName: res.name ?? `${spec.name}-${key}`,
    type: res.type,
    url: "",
    currentVersion: null,
    exists: false,
    status: { status: "unknown", reason: "preview" },
  }));
  const keys = new Set(nodes.map((n) => n.key));
  const edges: GraphEdge[] = [];
  for (const [key, res] of Object.entries(spec.resources)) {
    if (res.type === "app")
      for (const u of res.uses ?? []) {
        const target = u.database ?? u.bucket ?? u.cache ?? u.auth;
        if (target && keys.has(target)) edges.push({ from: target, to: key, kind: "uses", label: u.database ? "PG*" : u.bucket ? "S3_*" : u.cache ? "REDIS_URL" : "AUTH_*" });
      }
    if (res.type === "site") for (const e of res.env_from ?? []) if (keys.has(e.resource)) edges.push({ from: e.resource, to: key, kind: "env_from", label: "URL at publish" });
  }
  return { name: spec.name, specVersion: 0, nodes, edges };
}

/** The detail route for a graph node's workload type — the existing per-type detail page. */
export const stackNodePath = (n: { type: WorkloadType; siteName: string }): string => `/${n.type}/${encodeURIComponent(n.siteName)}`;

// Small shared display helpers (identical semantics to the old console).
export const pathFor = (w: { type: WorkloadType; name: string }): string => `/${w.type}/${encodeURIComponent(w.name)}`;
// Org display: a personal org's name is the owner's email (redundant on a card that shows
// the owner), so show "personal"; team orgs show their name.
export const orgLabel = (o?: { slug: string; name: string; kind: string } | null): string =>
  !o ? "—" : o.kind === "personal" ? "personal" : o.name;
export const shortVersion = (id: string): string => "#" + id.replace(/^v_\d+_/, "");
export const fmtStamp = (s: string | null): string => (s ? new Date(s).toISOString().replace("T", " ").slice(0, 19) : "—");
