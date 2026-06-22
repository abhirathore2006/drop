import type { Session } from "./session.ts";
import type { AppConfig } from "../app-config.ts";
import type { DatabaseConfig } from "../db-config.ts";

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
  deploy(name: string, app: AppConfig, org?: string) {
    return this.req("POST", `/v1/apps/${name}${this.orgQ(org)}`, {
      contentType: "application/json",
      body: JSON.stringify(app),
    });
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
  addOrgMember(slug: string, email: string, role?: string) {
    return this.req("POST", `/v1/orgs/${slug}/members`, { contentType: "application/json", body: JSON.stringify({ email, role }) });
  }
  removeOrgMember(slug: string, email: string) {
    return this.req("DELETE", `/v1/orgs/${slug}/members/${encodeURIComponent(email)}`);
  }
  dbPassword(name: string, password?: string) {
    return this.req("POST", `/v1/databases/${name}/password`, {
      contentType: "application/json",
      body: JSON.stringify(password ? { password } : {}),
    });
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
  list() {
    return this.req("GET", `/v1/sites`);
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
  transfer(name: string, email: string) {
    return this.req("POST", `/v1/sites/${name}/transfer`, {
      contentType: "application/json",
      body: JSON.stringify({ email }),
    });
  }
}
