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

  publish(name: string, tarball: Buffer | Uint8Array) {
    return this.req("POST", `/v1/sites/${name}/versions`, {
      contentType: "application/gzip",
      body: tarball,
    });
  }
  deploy(name: string, app: AppConfig) {
    return this.req("POST", `/v1/apps/${name}`, {
      contentType: "application/json",
      body: JSON.stringify(app),
    });
  }
  dbCreate(name: string, db: DatabaseConfig | Record<string, never>) {
    return this.req("POST", `/v1/databases/${name}`, {
      contentType: "application/json",
      body: JSON.stringify(db),
    });
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
