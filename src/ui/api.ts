// Typed client for the Drop control-plane API. Same-origin fetch carries the session cookie.

export type WorkloadType = "site" | "app" | "database";

export interface Me {
  email: string;
  admin: boolean;
}

export interface ListItem {
  name: string;
  type: WorkloadType;
  owner: string;
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
  collaborators: string[];
  members: { email: string; role: string }[];
  visibility: string;
  current: string | null;
  url: string;
  versions: Version[];
  app?: { image: string | null; scale: { min: number; max: number } | null; status: AppStatus | null };
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
};
