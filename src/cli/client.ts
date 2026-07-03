import type { Session } from "./session.ts";
import type { AppConfig } from "../app-config.ts";
import type { DatabaseConfig } from "../db-config.ts";
import type { StackSpec } from "../stack-config.ts";

export class Client {
  constructor(private s: Session) {}

  private async req(
    method: string,
    path: string,
    opts: { contentType?: string; body?: string | Uint8Array } = {},
  ): Promise<any> {
    const res = await fetch(this.s.apiBase + path, {
      method,
      headers: {
        authorization: `Bearer ${this.s.token}`,
        ...(opts.contentType ? { "content-type": opts.contentType } : {}),
      },
      body: opts.body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as any).error ?? `${path}: ${res.status}`);
    return json;
  }

  private orgQ(org?: string) {
    return org ? `?org=${encodeURIComponent(org)}` : "";
  }
  publish(name: string, tarball: Buffer | Uint8Array, org?: string) {
    return this.req("POST", `/v1/sites/${name}/versions${this.orgQ(org)}`, {
      contentType: "application/gzip",
      body: tarball,
    });
  }
  deploy(name: string, app: AppConfig, org?: string, noStart?: boolean) {
    const q = new URLSearchParams();
    if (org) q.set("org", org);
    if (noStart) q.set("start", "false");
    const qs = q.toString();
    return this.req("POST", `/v1/apps/${name}${qs ? `?${qs}` : ""}`, {
      contentType: "application/json",
      body: JSON.stringify(app),
    });
  }
  /** Stream a `docker save` image tarball to the API, which makes it pullable by the cluster.
   *  `body` is a Node Readable (the save stdout) so large images never buffer in memory. */
  async pushImage(name: string, body: NodeJS.ReadableStream | Uint8Array, tag: string, org?: string) {
    const q = new URLSearchParams({ tag });
    if (org) q.set("org", org);
    const res = await fetch(`${this.s.apiBase}/v1/apps/${name}/image?${q.toString()}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${this.s.token}`, "content-type": "application/octet-stream" },
      body: body as any,
      duplex: "half", // required by fetch when streaming a request body
    } as RequestInit);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as any).error ?? `image push: ${res.status}`);
    return json;
  }
  dbCreate(name: string, db: DatabaseConfig | Record<string, never>, org?: string) {
    return this.req("POST", `/v1/databases/${name}${this.orgQ(org)}`, {
      contentType: "application/json",
      body: JSON.stringify(db),
    });
  }
  // organisations
  createOrg(slug: string, name?: string) {
    return this.req("POST", `/v1/orgs`, { contentType: "application/json", body: JSON.stringify({ slug, name }) });
  }
  listOrgs() {
    return this.req("GET", `/v1/orgs`);
  }
  orgInfo(slug: string) {
    return this.req("GET", `/v1/orgs/${slug}`);
  }
  orgUsage(slug: string) {
    return this.req("GET", `/v1/orgs/${slug}/usage`);
  }
  addOrgMember(slug: string, email: string, role?: string) {
    return this.req("POST", `/v1/orgs/${slug}/members`, { contentType: "application/json", body: JSON.stringify({ email, role }) });
  }
  removeOrgMember(slug: string, email: string) {
    return this.req("DELETE", `/v1/orgs/${slug}/members/${encodeURIComponent(email)}`);
  }
  dbPassword(name: string, password?: string, setSecret?: { app: string; key: string }, show?: boolean) {
    return this.req("POST", `/v1/databases/${name}/password`, {
      contentType: "application/json",
      body: JSON.stringify({ ...(password ? { password } : {}), ...(setSecret ? { setSecret } : {}), ...(show ? { show: true } : {}) }),
    });
  }
  // managed-database backups + hibernation
  dbBackups(name: string) {
    return this.req("GET", `/v1/databases/${name}/backups`);
  }
  dbBackup(name: string) {
    return this.req("POST", `/v1/databases/${name}/backups`);
  }
  dbHibernate(name: string) {
    return this.req("POST", `/v1/databases/${name}/hibernate`);
  }
  dbWake(name: string) {
    return this.req("POST", `/v1/databases/${name}/wake`);
  }
  setSecret(app: string, key: string, value: string) {
    return this.req("PUT", `/v1/apps/${app}/secrets/${encodeURIComponent(key)}`, {
      contentType: "application/json",
      body: JSON.stringify({ value }),
    });
  }
  listSecrets(app: string) {
    return this.req("GET", `/v1/apps/${app}/secrets`);
  }
  deleteSecret(app: string, key: string) {
    return this.req("DELETE", `/v1/apps/${app}/secrets/${encodeURIComponent(key)}`);
  }
  restartApp(app: string) {
    return this.req("POST", `/v1/apps/${app}/restart`);
  }
  stopApp(app: string) {
    return this.req("POST", `/v1/apps/${app}/stop`);
  }
  startApp(app: string) {
    return this.req("POST", `/v1/apps/${app}/start`);
  }
  rollback(name: string, to: string) {
    return this.req("POST", `/v1/sites/${name}/rollback`, {
      contentType: "application/json",
      body: JSON.stringify({ to }),
    });
  }
  info(name: string) {
    return this.req("GET", `/v1/sites/${name}`);
  }
  /** Per-process status for an app (drop ps): one row per web/worker Deployment. */
  processes(app: string) {
    return this.req("GET", `/v1/apps/${app}/processes`);
  }
  /** Recent workload logs. `release` reads the latest release Job's pod instead of the app pods. */
  logs(name: string, opts: { tail?: number; release?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.tail) q.set("tail", String(opts.tail));
    if (opts.release) q.set("release", "1");
    const qs = q.toString();
    return this.req("GET", `/v1/sites/${name}/logs${qs ? `?${qs}` : ""}`);
  }
  list(org?: string) {
    return this.req("GET", `/v1/sites${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  }
  remove(name: string) {
    return this.req("DELETE", `/v1/sites/${name}`);
  }
  share(name: string, email: string) {
    return this.req("POST", `/v1/sites/${name}/collaborators`, {
      contentType: "application/json",
      body: JSON.stringify({ email }),
    });
  }
  unshare(name: string, email: string) {
    return this.req("DELETE", `/v1/sites/${name}/collaborators/${encodeURIComponent(email)}`);
  }
  transfer(name: string, target: { email?: string; toOrg?: string }) {
    return this.req("POST", `/v1/sites/${name}/transfer`, {
      contentType: "application/json",
      body: JSON.stringify(target),
    });
  }
  // stacks (B2): declarative multi-resource up + list/status/delete
  stackUp(
    name: string,
    spec: StackSpec,
    opts: { org?: string; dryRun?: boolean; prune?: boolean; resolved?: Record<string, { image: string }>; specVersion?: number } = {},
  ) {
    const q = new URLSearchParams();
    if (opts.org) q.set("org", opts.org);
    if (opts.dryRun) q.set("dry_run", "1");
    const qs = q.toString();
    return this.req("POST", `/v1/stacks/${name}/up${qs ? `?${qs}` : ""}`, {
      contentType: "application/json",
      body: JSON.stringify({ spec, ...(opts.resolved ? { resolved: opts.resolved } : {}), ...(opts.prune ? { prune: true } : {}), ...(opts.specVersion != null ? { spec_version: opts.specVersion } : {}) }),
    });
  }
  stackList(org?: string) {
    return this.req("GET", `/v1/stacks${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  }
  stackGet(name: string, org?: string) {
    return this.req("GET", `/v1/stacks/${name}${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  }
  stackDelete(name: string, opts: { org?: string; cascade?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.org) q.set("org", opts.org);
    if (opts.cascade) q.set("cascade", "1");
    const qs = q.toString();
    return this.req("DELETE", `/v1/stacks/${name}${qs ? `?${qs}` : ""}`);
  }
  // platform admin: users + roles + status
  adminListUsers() {
    return this.req("GET", `/v1/admin/users`);
  }
  adminSetRole(email: string, role: string) {
    return this.req("POST", `/v1/admin/users/${encodeURIComponent(email)}/role`, { contentType: "application/json", body: JSON.stringify({ role }) });
  }
  adminSetStatus(email: string, status: string) {
    return this.req("POST", `/v1/admin/users/${encodeURIComponent(email)}/status`, { contentType: "application/json", body: JSON.stringify({ status }) });
  }
  adminAudit(opts: { actor?: string; target?: string; action?: string; limit?: number; cursor?: string } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v != null && v !== "") q.set(k, String(v));
    const qs = q.toString();
    return this.req("GET", `/v1/admin/audit${qs ? `?${qs}` : ""}`);
  }
}
