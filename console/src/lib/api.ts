// Typed client for the Drop control-plane API. Same-origin fetch carries the session cookie.
// Errors are thrown as ApiError so callers (and the query layer's 401 interceptor) can
// branch on status.

export type WorkloadType = "site" | "app" | "database" | "bucket";

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
  workloads: { site: number; app: number; database: number; bucket: number; total: number };
  cap: number; // 0 = unlimited
  quota: { hard: Record<string, string>; used: Record<string, string> } | null;
  storage?: {
    databases: { count: number; requestedBytes: number };
    buckets: { count: number; bytes: number };
    budget: number | null; // null = no budget configured
  };
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
export interface Version {
  id: string;
  publishedBy: string;
  createdAt: string;
  fileCount: number;
  bytes: number;
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
  status?: ServerStatus | null;
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
  };
  bucket?: BucketInfo;
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
  rotateBucket: (name: string) =>
    req<{ name: string; endpoint: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string }>("POST", `/v1/buckets/${name}/rotate`, {}),
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
  orgUsage: (slug: string) => req<OrgUsage>("GET", `/v1/orgs/${encodeURIComponent(slug)}/usage`),
  // app secrets (write-only) + lifecycle
  listSecrets: (name: string) => req<{ secrets: SecretMeta[] }>("GET", `/v1/apps/${name}/secrets`),
  setSecret: (name: string, key: string, value: string) => req("PUT", `/v1/apps/${name}/secrets/${encodeURIComponent(key)}`, { value }),
  deleteSecret: (name: string, key: string) => req("DELETE", `/v1/apps/${name}/secrets/${encodeURIComponent(key)}`),
  restartApp: (name: string) => req("POST", `/v1/apps/${name}/restart`, {}),
  stopApp: (name: string) => req("POST", `/v1/apps/${name}/stop`, {}),
  startApp: (name: string) => req("POST", `/v1/apps/${name}/start`, {}),
  // TCP (L4) exposure (A2b)
  expose: (name: string, mode: "sni" | "port", protocol?: string) =>
    req<{ name: string; tcp: TcpExposure; note?: string }>("POST", `/v1/sites/${name}/expose`, { mode, ...(protocol ? { protocol } : {}) }),
  unexpose: (name: string) => req<{ name: string; tcp: null; note?: string }>("DELETE", `/v1/sites/${name}/expose`),
  // stacks (B2/C1)
  stacks: () => req<{ stacks: StackListItem[] }>("GET", "/v1/stacks"),
  stackGraph: (name: string) => req<StackGraph>("GET", `/v1/stacks/${encodeURIComponent(name)}/graph?include_plan=1`),
};

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
