// Real KubeClient: talks to the Kubernetes API via a kubeconfig using server-side
// apply (idempotent create-or-update). Intentionally dependency-light — Node's
// https + the yaml dep we already bundle — so the self-contained esbuild bundle
// stays free of @kubernetes/client-node. FakeKube covers unit tests; this is
// integration-verified against Floci's k3s (make compute-up) on a Docker host.
import { request } from "node:https";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { PasswordSyncError, type KubeClient, type AppStatus, type DatabaseStatus } from "./types.ts";
import type { AppManifests, TenantManifests } from "./manifests.ts";
import { databasePasswordJob, DEFAULT_OPERAND_IMAGE, PWSET_SECRET, type DatabaseManifests } from "./cnpg.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  /** Server-side apply a single object (create-or-update, idempotent). The body is JSON, not
   *  YAML: JSON is valid YAML (the apiserver parses it), and crucially it QUOTES every string —
   *  YAML-serializing would emit values like "yes"/"no"/"on"/"123" unquoted, which the apiserver's
   *  YAML-1.1 parser then coerces to booleans/numbers ("expected string, got true"), breaking any
   *  env value that looks YAML-ambiguous. */
  private async apply(path: string, obj: Record<string, unknown>): Promise<void> {
    const res = await this.call("PATCH", `${path}?fieldManager=drop&force=true`, {
      body: JSON.stringify(obj),
      contentType: "application/apply-patch+yaml",
    });
    if (res.status >= 300) throw new Error(`apply ${path} -> ${res.status}: ${res.body.slice(0, 300)}`);
  }

  private nsPath = (ns: string) => `/api/v1/namespaces/${ns}`;
  private deploymentPath = (ns: string, n: string) => `/apis/apps/v1/namespaces/${ns}/deployments/${n}`;
  private servicePath = (ns: string, n: string) => `/api/v1/namespaces/${ns}/services/${n}`;
  private hsoPath = (ns: string, n: string) => `/apis/http.keda.sh/v1alpha1/namespaces/${ns}/httpscaledobjects/${n}`;
  private secretPath = (ns: string, n: string) => `/api/v1/namespaces/${ns}/secrets/${n}`;
  private netpolPath = (ns: string, n: string) => `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${n}`;
  private quotaPath = (ns: string, n: string) => `/api/v1/namespaces/${ns}/resourcequotas/${n}`;
  private limitRangePath = (ns: string, n: string) => `/api/v1/namespaces/${ns}/limitranges/${n}`;
  private objectStorePath = (ns: string, n: string) => `/apis/barmancloud.cnpg.io/v1/namespaces/${ns}/objectstores/${n}`;
  private clusterPath = (ns: string, n: string) => `/apis/postgresql.cnpg.io/v1/namespaces/${ns}/clusters/${n}`;
  private scheduledBackupPath = (ns: string, n: string) => `/apis/postgresql.cnpg.io/v1/namespaces/${ns}/scheduledbackups/${n}`;
  private jobPath = (ns: string, n: string) => `/apis/batch/v1/namespaces/${ns}/jobs/${n}`;
  private objName = (o: Record<string, unknown>) => (o.metadata as { name: string }).name;

  /** Fail fast if a CRD's API group isn't served yet (SSA returns a bare 404 otherwise). */
  private async assertCrd(group: string): Promise<void> {
    const r = await this.call("GET", `/apis/${group}`);
    if (r.status >= 300) throw new Error(`compute not ready: ${group} CRD not installed (run make compute-up)`);
  }

  async applyTenant(namespace: string, t: TenantManifests): Promise<void> {
    await this.apply(this.nsPath(namespace), t.namespace as Record<string, unknown>);
    await this.apply(this.netpolPath(namespace, this.objName(t.networkPolicy)), t.networkPolicy as Record<string, unknown>);
    await this.apply(this.quotaPath(namespace, this.objName(t.resourceQuota)), t.resourceQuota as Record<string, unknown>);
    await this.apply(this.limitRangePath(namespace, this.objName(t.limitRange)), t.limitRange as Record<string, unknown>);
  }

  async applyApp(namespace: string, name: string, m: AppManifests): Promise<void> {
    // Fail fast BEFORE creating any app object: on a cluster without the KEDA HTTP
    // add-on, applying then throwing would orphan the Deployment/Service/NetworkPolicy.
    await this.assertCrd("http.keda.sh");
    // namespace is provisioned (PSA-labeled) by applyTenant — don't re-apply a bare one here.
    // The env Secret is REPLACED, not server-side-merged: SSA on a Secret's stringData does
    // NOT prune keys removed since the last deploy. DELETE unconditionally (404 if absent —
    // harmless) so a removed env var, OR an env block removed ENTIRELY (m.secret undefined),
    // never leaves a stale Secret behind; then re-create only if the app still has env.
    await this.call("DELETE", this.secretPath(namespace, `${name}-env`));
    if (m.secret) await this.apply(this.secretPath(namespace, this.objName(m.secret)), m.secret as Record<string, unknown>);
    await this.apply(this.deploymentPath(namespace, name), m.deployment as Record<string, unknown>);
    await this.apply(this.servicePath(namespace, name), m.service as Record<string, unknown>);
    await this.apply(this.netpolPath(namespace, this.objName(m.ingressPolicy)), m.ingressPolicy as Record<string, unknown>);
    await this.apply(this.hsoPath(namespace, name), m.httpScaledObject as Record<string, unknown>);
  }

  async deleteApp(namespace: string, name: string): Promise<void> {
    await this.call("DELETE", this.hsoPath(namespace, name));
    await this.call("DELETE", this.netpolPath(namespace, `${name}-allow-interceptor`));
    await this.call("DELETE", this.servicePath(namespace, name));
    await this.call("DELETE", this.secretPath(namespace, `${name}-env`));
    await this.call("DELETE", this.deploymentPath(namespace, name));
  }

  async applyDatabase(namespace: string, name: string, m: DatabaseManifests): Promise<void> {
    // Fail fast BEFORE creating any object: a cluster without CNPG + the Barman Cloud
    // Plugin would orphan the Secret/NetworkPolicy and 404 on the Cluster/ObjectStore.
    await this.assertCrd("postgresql.cnpg.io"); // the CNPG operator (Cluster/ScheduledBackup)
    await this.assertCrd("barmancloud.cnpg.io"); // the Barman Cloud Plugin (ObjectStore)
    // Order: app creds + S3 Secret → ObjectStore (refs the S3 Secret) → Cluster (refs the
    // ObjectStore AND bootstraps from the app creds Secret) → ScheduledBackup; NetworkPolicy
    // any time. The app creds Secret exists only on create (m.appSecret); on update it already
    // exists and bootstrap is immutable, so we leave it untouched (never re-rotate).
    if (m.appSecret) await this.apply(this.secretPath(namespace, this.objName(m.appSecret)), m.appSecret as Record<string, unknown>);
    if (m.secret) await this.apply(this.secretPath(namespace, this.objName(m.secret)), m.secret as Record<string, unknown>);
    await this.apply(this.objectStorePath(namespace, this.objName(m.objectStore)), m.objectStore as Record<string, unknown>);
    await this.apply(this.clusterPath(namespace, name), m.cluster as Record<string, unknown>);
    await this.apply(this.scheduledBackupPath(namespace, this.objName(m.scheduledBackup)), m.scheduledBackup as Record<string, unknown>);
    await this.apply(this.netpolPath(namespace, this.objName(m.networkPolicy)), m.networkPolicy as Record<string, unknown>);
  }

  async deleteDatabase(namespace: string, name: string): Promise<void> {
    // Deleting the Cluster cascades to its instance pods; PVCs follow CNPG's retention.
    await this.call("DELETE", this.scheduledBackupPath(namespace, `${name}-daily`));
    await this.call("DELETE", this.clusterPath(namespace, name));
    await this.call("DELETE", this.objectStorePath(namespace, `${name}-store`));
    await this.call("DELETE", this.netpolPath(namespace, `${name}-db`));
    await this.call("DELETE", this.secretPath(namespace, `${name}-backup-creds`));
    await this.call("DELETE", this.secretPath(namespace, PWSET_SECRET(name))); // reap a crash-orphaned rotation Secret
  }

  private podsPath = (ns: string, n: string) =>
    `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${n}`)}`;

  async getAppStatus(namespace: string, name: string): Promise<AppStatus | null> {
    const r = await this.call("GET", this.deploymentPath(namespace, name));
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`getAppStatus ${name} -> ${r.status}`);
    const s = (JSON.parse(r.body).status ?? {}) as { replicas?: number; readyReplicas?: number };
    // Restarts + crash reason come from the PODS (the Deployment status has neither).
    let restarts = 0;
    let reason = (s.replicas ?? 0) === 0 ? "ScaledToZero" : "NoPods";
    try {
      const pr = await this.call("GET", this.podsPath(namespace, name));
      if (pr.status < 300) {
        const pods = (JSON.parse(pr.body).items ?? []) as any[];
        if (pods.length) {
          for (const p of pods) {
            for (const cs of p.status?.containerStatuses ?? []) restarts = Math.max(restarts, cs.restartCount ?? 0);
          }
          // reason from the newest pod's app container: waiting reason (e.g. CrashLoopBackOff) or phase.
          const newest = pods[pods.length - 1];
          const cs = (newest.status?.containerStatuses ?? []).find((c: any) => c.name === name) ?? newest.status?.containerStatuses?.[0];
          reason = cs?.state?.waiting?.reason ?? cs?.state?.terminated?.reason ?? newest.status?.phase ?? reason;
        }
      }
    } catch {
      /* leave restarts/reason at defaults */
    }
    return { replicas: s.replicas ?? 0, ready: s.readyReplicas ?? 0, restarts, reason };
  }

  async getWorkloadLogs(namespace: string, name: string, tailLines = 100): Promise<string> {
    // find a pod for this workload — apps label app.kubernetes.io/name; CNPG uses cnpg.io/cluster
    // (scope to the PRIMARY so a multi-instance cluster doesn't return a replica's logs).
    for (const sel of [`app.kubernetes.io/name=${name}`, `cnpg.io/cluster=${name},cnpg.io/instanceRole=primary`]) {
      const pr = await this.call("GET", `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(sel)}`);
      if (pr.status >= 300) continue;
      const pods = (JSON.parse(pr.body).items ?? []) as any[];
      if (!pods.length) continue;
      const pod = pods[pods.length - 1].metadata.name as string;
      const lr = await this.call("GET", `/api/v1/namespaces/${namespace}/pods/${pod}/log?tailLines=${tailLines}&container=${name}`);
      // container=name may 404 for CNPG (container is "postgres"); retry without the container filter.
      if (lr.status >= 300) {
        const lr2 = await this.call("GET", `/api/v1/namespaces/${namespace}/pods/${pod}/log?tailLines=${tailLines}`);
        return lr2.status < 300 ? lr2.body : "";
      }
      return lr.body;
    }
    return "";
  }

  /** Rotate the managed DB's `app` password: run a one-shot (idempotent) Job that ALTERs the role
   *  from inside the namespace, then — only on success — update the `<name>-app` creds Secret to
   *  match. If the Job never succeeds we throw with the role unchanged (Secret stays valid). If the
   *  role WAS rotated but the Secret write then fails (after retries), we throw PasswordSyncError so
   *  the caller surfaces the now-live password instead of losing it. */
  async setDatabasePassword(namespace: string, name: string, newPassword: string): Promise<void> {
    // Reuse the cluster's own operand image (already on the node → no pull) when known.
    const cr = await this.call("GET", this.clusterPath(namespace, name));
    if (cr.status === 404) throw new Error(`no such database: ${name}`);
    if (cr.status >= 300) throw new Error(`setDatabasePassword ${name}: cluster read -> ${cr.status}`);
    const image = (JSON.parse(cr.body).status?.image as string) || DEFAULT_OPERAND_IMAGE;

    const jp = this.jobPath(namespace, name + "-pwset");
    const pwSecretPath = this.secretPath(namespace, PWSET_SECRET(name));
    const cleanup = async () => {
      await this.call("DELETE", `${jp}?propagationPolicy=Foreground`).catch(() => {});
      await this.call("DELETE", pwSecretPath).catch(() => {}); // the short-lived NEWPW Secret
    };

    // Reap any leftovers from a prior run FIRST — including a pwset Secret a crash may have
    // orphaned (it has no owner/TTL, so nothing else GCs it) — then wait until the Job is actually
    // GONE (404, NOT merely the next non-2xx: a transient 5xx must not be misread as "gone").
    await cleanup();
    for (let i = 0; i < 30 && (await this.call("GET", jp)).status !== 404; i++) await sleep(1000);

    // try/finally so cleanup ALWAYS runs — a throw between creating the pwset Secret/Job and a
    // terminal branch must never leave the cleartext-NEWPW Secret or the Job orphaned.
    try {
      // Deliver the target password via a short-lived Secret (no plaintext in the Job/Pod spec),
      // then apply the Job. Order matters: the Job's secretKeyRef resolves at pod start.
      await this.apply(pwSecretPath, {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: PWSET_SECRET(name), namespace },
        stringData: { NEWPW: newPassword },
      });
      await this.apply(jp, databasePasswordJob({ name, namespace, image }));

      // Poll to a terminal state (succeeded, or Failed/DeadlineExceeded). 75×2s > the Job's
      // activeDeadlineSeconds (120s) so we always observe the terminal status, never time out early.
      let succeeded = false;
      for (let i = 0; i < 75; i++) {
        await sleep(2000);
        const r = await this.call("GET", jp);
        if (r.status >= 300) continue;
        const st = (JSON.parse(r.body).status ?? {}) as { succeeded?: number; failed?: number; conditions?: { type: string; status: string }[] };
        if (st.succeeded && st.succeeded >= 1) { succeeded = true; break; }
        if ((st.conditions ?? []).some((c) => c.type === "Failed" && c.status === "True")) break; // backoff/deadline exhausted
        if (st.failed && st.failed >= 3) break;
      }

      if (!succeeded) {
        const logs = await this.getWorkloadLogs(namespace, name + "-pwset", 20).catch(() => "");
        throw new Error(`password rotation Job did not succeed for ${name}${logs ? `: ${logs.slice(-300)}` : ""}`);
      }

      // Role password is now the new one — persist it to the creds Secret (we own this Secret; CNPG
      // does not reconcile a bootstrap.initdb.secret, so the update sticks). RETRY: losing this write
      // loses the only copy of a now-live password.
      let synced = false;
      for (let i = 0; i < 5 && !synced; i++) {
        try {
          await this.apply(this.secretPath(namespace, `${name}-app`), {
            apiVersion: "v1",
            kind: "Secret",
            type: "kubernetes.io/basic-auth",
            metadata: { name: `${name}-app`, namespace },
            stringData: { username: "app", password: newPassword },
          });
          synced = true;
        } catch {
          if (i < 4) await sleep(1500);
        }
      }
      if (!synced) {
        // role=NEW, Secret=OLD. The returned password is now the ONLY live copy, and because the
        // next rotation's Job authenticates from this (stale) Secret, the divergence also WEDGES
        // all future rotations until the Secret is repaired. Make that explicit.
        throw new PasswordSyncError(
          `${name}: the role password WAS rotated but the ${name}-app Secret could not be updated. The returned password is now the only live copy — re-apply it to the ${name}-app Secret (key "password") immediately; until you do, apps will fail to authenticate and further rotations of this database will fail.`,
        );
      }
    } finally {
      await cleanup();
    }
  }

  async getDatabaseStatus(namespace: string, name: string): Promise<DatabaseStatus | null> {
    const r = await this.call("GET", this.clusterPath(namespace, name));
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`getDatabaseStatus ${name} -> ${r.status}`);
    const o = JSON.parse(r.body) as { status?: { phase?: string; readyInstances?: number }; spec?: { instances?: number } };
    return { phase: o.status?.phase ?? "unknown", ready: o.status?.readyInstances ?? 0, instances: o.spec?.instances ?? 0 };
  }

  async getApp(namespace: string, name: string): Promise<AppManifests | null> {
    const d = await this.call("GET", this.deploymentPath(namespace, name));
    if (d.status === 404) return null;
    if (d.status >= 300) throw new Error(`getApp ${name} -> ${d.status}`);
    const s = await this.call("GET", this.servicePath(namespace, name));
    const h = await this.call("GET", this.hsoPath(namespace, name));
    const ip = await this.call("GET", this.netpolPath(namespace, `${name}-allow-interceptor`));
    return {
      deployment: JSON.parse(d.body),
      service: s.status < 300 ? JSON.parse(s.body) : {},
      httpScaledObject: h.status < 300 ? JSON.parse(h.body) : {},
      ingressPolicy: ip.status < 300 ? JSON.parse(ip.body) : {},
    };
  }
}
