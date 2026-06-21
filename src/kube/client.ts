// Real KubeClient: talks to the Kubernetes API via a kubeconfig using server-side
// apply (idempotent create-or-update). Intentionally dependency-light — Node's
// https + the yaml dep we already bundle — so the self-contained esbuild bundle
// stays free of @kubernetes/client-node. FakeKube covers unit tests; this is
// integration-verified against Floci's k3s (make compute-up) on a Docker host.
import { request } from "node:https";
import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { KubeClient } from "./types.ts";
import type { AppManifests } from "./manifests.ts";

interface KubeConn {
  server: string;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  token?: string;
}

function loadKubeconfig(path: string): KubeConn {
  const kc = parseYaml(readFileSync(path, "utf8")) as any;
  const ctx = kc.contexts?.find((c: any) => c.name === kc["current-context"])?.context;
  if (!ctx) throw new Error(`kubeconfig ${path}: no current-context`);
  const cluster = kc.clusters?.find((c: any) => c.name === ctx.cluster)?.cluster;
  const user = kc.users?.find((u: any) => u.name === ctx.user)?.user;
  if (!cluster?.server) throw new Error(`kubeconfig ${path}: cluster has no server`);
  const b64 = (s?: string) => (s ? Buffer.from(s, "base64") : undefined);
  return {
    server: cluster.server,
    ca: b64(cluster["certificate-authority-data"]),
    cert: b64(user?.["client-certificate-data"]),
    key: b64(user?.["client-key-data"]),
    token: user?.token,
  };
}

export class KubeApiClient implements KubeClient {
  private conn: KubeConn;
  constructor(kubeconfigPath: string) {
    this.conn = loadKubeconfig(kubeconfigPath);
  }

  private call(method: string, path: string, opts: { body?: string; contentType?: string } = {}): Promise<{ status: number; body: string }> {
    const u = new URL(this.conn.server + path);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          method,
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          ca: this.conn.ca,
          cert: this.conn.cert,
          key: this.conn.key,
          headers: {
            ...(this.conn.token ? { authorization: `Bearer ${this.conn.token}` } : {}),
            ...(opts.contentType ? { "content-type": opts.contentType } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  /** Server-side apply a single object (create-or-update, idempotent). */
  private async apply(path: string, obj: Record<string, unknown>): Promise<void> {
    const res = await this.call("PATCH", `${path}?fieldManager=drop&force=true`, {
      body: stringifyYaml(obj),
      contentType: "application/apply-patch+yaml",
    });
    if (res.status >= 300) throw new Error(`apply ${path} -> ${res.status}: ${res.body.slice(0, 300)}`);
  }

  private deploymentPath = (ns: string, n: string) => `/apis/apps/v1/namespaces/${ns}/deployments/${n}`;
  private servicePath = (ns: string, n: string) => `/api/v1/namespaces/${ns}/services/${n}`;
  private hsoPath = (ns: string, n: string) => `/apis/http.keda.sh/v1alpha1/namespaces/${ns}/httpscaledobjects/${n}`;

  async applyApp(namespace: string, name: string, m: AppManifests): Promise<void> {
    await this.apply(`/api/v1/namespaces/${namespace}`, { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
    await this.apply(this.deploymentPath(namespace, name), m.deployment as Record<string, unknown>);
    await this.apply(this.servicePath(namespace, name), m.service as Record<string, unknown>);
    await this.apply(this.hsoPath(namespace, name), m.httpScaledObject as Record<string, unknown>);
  }

  async deleteApp(namespace: string, name: string): Promise<void> {
    await this.call("DELETE", this.hsoPath(namespace, name));
    await this.call("DELETE", this.servicePath(namespace, name));
    await this.call("DELETE", this.deploymentPath(namespace, name));
  }

  async getApp(namespace: string, name: string): Promise<AppManifests | null> {
    const d = await this.call("GET", this.deploymentPath(namespace, name));
    if (d.status === 404) return null;
    if (d.status >= 300) throw new Error(`getApp ${name} -> ${d.status}`);
    const s = await this.call("GET", this.servicePath(namespace, name));
    const h = await this.call("GET", this.hsoPath(namespace, name));
    return {
      deployment: JSON.parse(d.body),
      service: s.status < 300 ? JSON.parse(s.body) : {},
      httpScaledObject: h.status < 300 ? JSON.parse(h.body) : {},
    };
  }
}
