// Typed client for the Drop control-plane API. Same-origin fetch carries the session cookie.

export type WorkloadType = "site" | "app" | "database";

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

export interface OrgUsage {
  org: { slug: string; name: string; kind: string };
  workloads: { site: number; app: number; database: number; total: number };
  cap: number; // 0 = unlimited
  quota: { hard: Record<string, string>; used: Record<string, string> } | null;
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

export interface ListItem {
  name: string;
  type: WorkloadType;
  owner: string;
  org?: Org | null;
  visibility: string;
  url: string;
  current: string | null;
  collaborators?: number;
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
}
export interface Version {
  id: string;
  publishedBy: string;
  createdAt: string;
  fileCount: number;
  bytes: number;
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
  app?: {
    image: string | null;
    scale: { min: number; max: number } | null;
    resources?: { cpu?: string; memory?: string } | null;
    status: AppStatus | null;
    runtimeState?: "running" | "stopped";
  };
  database?: { host: string; port: number; database: string; user: string; credentialsSecret: string; status: DatabaseStatus | null };
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any).error ?? `${path}: ${res.status}`);
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
  setDbPassword: (name: string) => req<{ name: string; user: string; password: string; warning?: string }>("POST", `/v1/databases/${name}/password`, {}),
  addCollaborator: (name: string, email: string) => req("POST", `/v1/sites/${name}/collaborators`, { email }),
  removeCollaborator: (name: string, email: string) =>
    req("DELETE", `/v1/sites/${name}/collaborators/${encodeURIComponent(email)}`),
  transfer: (name: string, email: string) => req("POST", `/v1/sites/${name}/transfer`, { email }),
  remove: (name: string) => req("DELETE", `/v1/sites/${name}`),
  setUserStatus: (email: string, status: "active" | "suspended") =>
    req("POST", `/v1/admin/users/${encodeURIComponent(email)}/status`, { status }),
  adminUsers: () => req<{ users: AdminUser[] }>("GET", "/v1/admin/users"),
  setUserRole: (email: string, role: "admin" | "member") =>
    req("POST", `/v1/admin/users/${encodeURIComponent(email)}/role`, { role }),
  adminAudit: (qs: string) => req<{ entries: AuditRecord[]; nextCursor?: string }>("GET", "/v1/admin/audit" + (qs ? `?${qs}` : "")),
  orgUsage: (slug: string) => req<OrgUsage>("GET", `/v1/orgs/${encodeURIComponent(slug)}/usage`),
  // app secrets (write-only) + lifecycle
  listSecrets: (name: string) => req<{ secrets: { key: string; fingerprint: string; updatedBy: string; updatedAt: string }[] }>("GET", `/v1/apps/${name}/secrets`),
  setSecret: (name: string, key: string, value: string) => req("PUT", `/v1/apps/${name}/secrets/${encodeURIComponent(key)}`, { value }),
  deleteSecret: (name: string, key: string) => req("DELETE", `/v1/apps/${name}/secrets/${encodeURIComponent(key)}`),
  restartApp: (name: string) => req("POST", `/v1/apps/${name}/restart`, {}),
  stopApp: (name: string) => req("POST", `/v1/apps/${name}/stop`, {}),
  startApp: (name: string) => req("POST", `/v1/apps/${name}/start`, {}),
};
