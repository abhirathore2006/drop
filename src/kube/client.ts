// Real KubeClient: talks to the Kubernetes API via a kubeconfig using server-side
// apply (idempotent create-or-update). Intentionally dependency-light — Node's
// https + the yaml dep we already bundle — so the self-contained esbuild bundle
// stays free of @kubernetes/client-node. FakeKube covers unit tests; this is
// integration-verified against Floci's k3s (make compute-up) on a Docker host.
import { request } from "node:https";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { parse as parseYaml } from "yaml";
import {
  PasswordSyncError,
  type KubeClient,
  type AppStatus,
  type DatabaseStatus,
  type TenantUsage,
  type BackupInfo,
  type ProcessStatus,
  type ReleaseResult,
} from "./types.ts";
import type { AppManifests, TenantManifests } from "./manifests.ts";
import { openKubeExecStream, type KubeExecSession } from "./exec.ts";
import { databaseBackupManifest, databasePasswordJob, DEFAULT_OPERAND_IMAGE, PWSET_SECRET, poolerName, type DatabaseManifests } from "./cnpg.ts";
import type { CacheManifests } from "./valkey.ts";
import type { AuthManifests } from "../auth-resource/manifests.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Restart count + crash reason distilled from a Deployment's pods (Deployment .status carries
 *  neither). Pure so getAppStatus (single pod GET) and listNamespaceAppStatuses (one namespace-wide
 *  pod GET, grouped) share identical logic. `deploymentName` picks the container whose name matches. */
function reasonFromPods(pods: any[], deploymentName: string, replicas: number): { restarts: number; reason: string } {
  let restarts = 0;
  let reason = replicas === 0 ? "ScaledToZero" : "NoPods";
  if (pods.length) {
    for (const p of pods) for (const cs of p.status?.containerStatuses ?? []) restarts = Math.max(restarts, cs.restartCount ?? 0);
    const newest = pods[pods.length - 1];
    const cs = (newest.status?.containerStatuses ?? []).find((c: any) => c.name === deploymentName) ?? newest.status?.containerStatuses?.[0];
    reason = cs?.state?.waiting?.reason ?? cs?.state?.terminated?.reason ?? newest.status?.phase ?? reason;
  }
  return { restarts, reason };
}

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

/** In-cluster connection from the pod's ServiceAccount (used when DROP_KUBECONFIG="in-cluster" — the
 *  EKS/Helm deployment path). Reads the SA token + CA that Kubernetes projects into every pod and the
 *  API server address from the injected env. Params injectable for tests. */
export function inClusterConn(
  env: Record<string, string | undefined> = process.env,
  read: (p: string) => Buffer = readFileSync,
  saDir = "/var/run/secrets/kubernetes.io/serviceaccount",
): KubeConn {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error('DROP_KUBECONFIG="in-cluster" but KUBERNETES_SERVICE_HOST is unset — not running inside a pod');
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT ?? "443";
  return {
    server: `https://${host}:${port}`,
    ca: read(`${saDir}/ca.crt`),
    token: read(`${saDir}/token`).toString("utf8").trim(),
  };
}

export class KubeApiClient implements KubeClient {
  private conn: KubeConn;
  /** `kubeconfigPath` is a file path, or the sentinel "in-cluster" to use the pod ServiceAccount. */
  constructor(kubeconfigPath: string) {
    this.conn = kubeconfigPath === "in-cluster" ? inClusterConn() : loadKubeconfig(kubeconfigPath);
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
  private backupPath = (ns: string, n: string) => `/apis/postgresql.cnpg.io/v1/namespaces/${ns}/backups/${n}`;
  private jobPath = (ns: string, n: string) => `/apis/batch/v1/namespaces/${ns}/jobs/${n}`;
  private cronJobPath = (ns: string, n: string) => `/apis/batch/v1/namespaces/${ns}/cronjobs/${n}`; // (H2)
  // Also the KEDA core ScaledObject the HTTP add-on auto-creates for the web process (see stopApp/
  // startApp's pause-annotation dance) — same kind, same path shape, reused for (L1b) worker
  // ScaledObjects below since a worker's name (`<app>-<process>`) never collides with the web app name.
  private scaledObjectPath = (ns: string, n: string) => `/apis/keda.sh/v1alpha1/namespaces/${ns}/scaledobjects/${n}`;
  private triggerAuthPath = (ns: string, n: string) => `/apis/keda.sh/v1alpha1/namespaces/${ns}/triggerauthentications/${n}`; // (L1b)
  private objName = (o: Record<string, unknown>) => (o.metadata as { name: string }).name;

  /** Fail fast if a CRD's API group isn't served yet (SSA returns a bare 404 otherwise). */
  private async assertCrd(group: string): Promise<void> {
    const r = await this.call("GET", `/apis/${group}`);
    if (r.status >= 300) throw new Error(`compute not ready: ${group} CRD not installed (locally: 'make up' / 'make cluster-up' — not DROP_APPS_ONLY; in prod: install the operator)`);
  }

  async applyTenant(namespace: string, t: TenantManifests): Promise<void> {
    await this.apply(this.nsPath(namespace), t.namespace as Record<string, unknown>);
    await this.apply(this.netpolPath(namespace, this.objName(t.networkPolicy)), t.networkPolicy as Record<string, unknown>);
    await this.apply(this.quotaPath(namespace, this.objName(t.resourceQuota)), t.resourceQuota as Record<string, unknown>);
    await this.apply(this.limitRangePath(namespace, this.objName(t.limitRange)), t.limitRange as Record<string, unknown>);
    // (A2b) Apply the per-workload "allow from edge-tcp" policies, then prune any left from a workload
    // that has since been unexposed (SSA can't prune a policy that's no longer in this manifest set).
    const keep = new Set<string>();
    for (const p of t.edgeTcpPolicies ?? []) {
      const n = this.objName(p);
      keep.add(n);
      await this.apply(this.netpolPath(namespace, n), p as Record<string, unknown>);
    }
    await this.pruneEdgeTcpPolicies(namespace, keep);
  }

  /** Delete tenant edge-tcp allow policies (label drop.dev/allow=edge-tcp) not in `keep`. */
  private async pruneEdgeTcpPolicies(namespace: string, keep: Set<string>): Promise<void> {
    const sel = encodeURIComponent("app.kubernetes.io/managed-by=drop,drop.dev/allow=edge-tcp");
    const r = await this.call("GET", `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies?labelSelector=${sel}`);
    if (r.status >= 300) return;
    for (const p of (JSON.parse(r.body).items ?? []) as any[]) {
      const pn = p.metadata?.name as string | undefined;
      if (pn && !keep.has(pn)) await this.call("DELETE", this.netpolPath(namespace, pn));
    }
  }

  /** (A2b) Set the edge-tcp Service's published ports (MERGE-patch spec.ports, so the port list is
   *  replaced wholesale with the caller's shared + active-dynamic set — the LB controller reconciles
   *  NLB listeners from it). 404 (Service not created yet) is surfaced so the caller can note it. */
  async patchEdgeTcpPorts(namespace: string, service: string, ports: { name: string; port: number }[]): Promise<void> {
    const body = JSON.stringify({ spec: { ports: ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.port, protocol: "TCP" })) } });
    const r = await this.call("PATCH", this.servicePath(namespace, service), { body, contentType: "application/merge-patch+json" });
    if (r.status === 404) throw new Error(`edge-tcp Service ${namespace}/${service} not found — is the L4 plane deployed?`);
    if (r.status >= 300) throw new Error(`patchEdgeTcpPorts ${service} -> ${r.status}: ${r.body.slice(0, 200)}`);
  }

  async applyApp(namespace: string, name: string, m: AppManifests): Promise<void> {
    // Fail fast BEFORE creating any app object: on a cluster without the KEDA HTTP add-on, applying
    // then throwing would orphan the Deployment/Service/NetworkPolicy. Only the web process needs
    // the HTTP add-on — a worker-only app has no HTTPScaledObject and shouldn't require it.
    if (m.httpScaledObject) await this.assertCrd("http.keda.sh");
    // (L1b) Same reasoning for a queue-scaled worker's core KEDA ScaledObject/TriggerAuthentication —
    // fail before creating the worker Deployment rather than orphan it on a cluster without KEDA core
    // installed (distinct from the HTTP add-on check above: a worker-only app never touches that one).
    if ((m.workers ?? []).some((w) => w.scaledObject)) await this.assertCrd("keda.sh");
    // namespace is provisioned (PSA-labeled) by applyTenant — don't re-apply a bare one here.
    // The env Secret is REPLACED, not server-side-merged: SSA on a Secret's stringData does
    // NOT prune keys removed since the last deploy. DELETE unconditionally (404 if absent —
    // harmless) so a removed env var, OR an env block removed ENTIRELY (m.secret undefined),
    // never leaves a stale Secret behind; then re-create only if the app still has env.
    await this.call("DELETE", this.secretPath(namespace, `${name}-env`));
    if (m.secret) await this.apply(this.secretPath(namespace, this.objName(m.secret)), m.secret as Record<string, unknown>);
    // Web process objects (absent for a worker-only app).
    if (m.deployment) await this.apply(this.deploymentPath(namespace, name), m.deployment as Record<string, unknown>);
    if (m.service) await this.apply(this.servicePath(namespace, name), m.service as Record<string, unknown>);
    if (m.ingressPolicy) await this.apply(this.netpolPath(namespace, this.objName(m.ingressPolicy)), m.ingressPolicy as Record<string, unknown>);
    if (m.httpScaledObject) await this.apply(this.hsoPath(namespace, name), m.httpScaledObject as Record<string, unknown>);
    // Worker process Deployments: apply the current set, then prune any worker removed since the
    // last deploy (SSA can't prune an object that's no longer in the manifest list). (L1b) A scale_on
    // worker ALSO carries a TriggerAuthentication + ScaledObject — apply the auth first since the
    // ScaledObject's authenticationRef names it.
    for (const w of m.workers ?? []) {
      await this.apply(this.deploymentPath(namespace, w.name), w.deployment as Record<string, unknown>);
      if (w.triggerAuth) await this.apply(this.triggerAuthPath(namespace, this.objName(w.triggerAuth)), w.triggerAuth as Record<string, unknown>);
      if (w.scaledObject) await this.apply(this.scaledObjectPath(namespace, this.objName(w.scaledObject)), w.scaledObject as Record<string, unknown>);
    }
    await this.pruneWorkers(namespace, name, new Set((m.workers ?? []).map((w) => w.name)));
    // (L1b) Prune ScaledObjects/TriggerAuthentications for any worker that no longer declares
    // scale_on (toggled off) or was removed entirely — same "keep set" pattern as pruneWorkers, keyed
    // by the SAME worker names since a scale_on worker's queue-scaling objects share its Deployment name.
    await this.pruneQueueScaling(namespace, name, new Set((m.workers ?? []).filter((w) => w.scaledObject).map((w) => w.name)));

    // (H2) `schedule` → a CronJob instead of the whole web/worker shape (assertProcesses already
    // refused schedule alongside processes/an explicit services/healthcheck, so m.cronJob and
    // m.deployment are never BOTH set). An app CAN toggle `schedule` on/off across deploys though, so
    // when the CURRENT manifests carry a CronJob, also tear down any Deployment/Service/HSO left from
    // a PRIOR non-cron deploy of the same app name — SSA can't prune a shape that isn't in this
    // manifest set at all. DELETE is idempotent/404-safe either way.
    if (m.cronJob) {
      if (!m.deployment) {
        await this.call("DELETE", this.hsoPath(namespace, name));
        await this.call("DELETE", this.netpolPath(namespace, `${name}-allow-interceptor`));
        await this.call("DELETE", this.servicePath(namespace, name));
        await this.call("DELETE", this.deploymentPath(namespace, name));
        await this.pruneWorkers(namespace, name, new Set());
        await this.pruneQueueScaling(namespace, name, new Set()); // (L1b) a CronJob has no workers either
      }
      await this.apply(this.cronJobPath(namespace, name), m.cronJob as Record<string, unknown>);
    } else {
      await this.deleteCronJob(namespace, name); // toggled OFF `schedule` — reap the stale CronJob (+ its Jobs)
    }
  }

  private cronJobSelector = (name: string) => encodeURIComponent(`drop.dev/workload=${name},drop.dev/kind=cron`);

  /** Delete the CronJob object AND its spawned Jobs (found by label — a run's Job name isn't
   *  predictable). The CronJob controller sets ownerReferences on those Jobs, so background GC would
   *  eventually reap them too, but doing it explicitly (same pattern as deleteReleaseJobs) means
   *  teardown doesn't leave retained run history (successfulJobsHistoryLimit/failedJobsHistoryLimit)
   *  lingering. Safe if the app was never a cron app (every DELETE 404s harmlessly). */
  private async deleteCronJob(namespace: string, name: string): Promise<void> {
    await this.call("DELETE", this.cronJobPath(namespace, name));
    const r = await this.call("GET", `/apis/batch/v1/namespaces/${namespace}/jobs?labelSelector=${this.cronJobSelector(name)}`);
    if (r.status >= 300) return;
    for (const j of (JSON.parse(r.body).items ?? []) as any[]) {
      const jn = j.metadata?.name as string | undefined;
      if (jn) await this.call("DELETE", `${this.jobPath(namespace, jn)}?propagationPolicy=Foreground`);
    }
  }

  /** Delete worker Deployments for an app that aren't in `keep` (label drop.dev/process distinguishes
   *  workers from the web Deployment, which never carries it → is never pruned). */
  private async pruneWorkers(namespace: string, name: string, keep: Set<string>): Promise<void> {
    const sel = encodeURIComponent(`drop.dev/workload=${name},drop.dev/process`);
    const r = await this.call("GET", `/apis/apps/v1/namespaces/${namespace}/deployments?labelSelector=${sel}`);
    if (r.status >= 300) return;
    for (const d of (JSON.parse(r.body).items ?? []) as any[]) {
      const dn = d.metadata?.name as string | undefined;
      if (dn && !keep.has(dn)) await this.call("DELETE", this.deploymentPath(namespace, dn));
    }
  }

  /** (L1b) Delete queue-scaling ScaledObjects/TriggerAuthentications for an app's workers that aren't
   *  in `keep` — same label (`drop.dev/workload`+`drop.dev/process`) and prune-by-GET-then-diff pattern
   *  as pruneWorkers, just against the two extra KEDA-core kinds a scale_on worker carries. Covers a
   *  worker whose `scale_on` was removed (still exists, no longer queue-scaled), one removed entirely,
   *  and — via the empty `keep` set callers pass — full teardown (deleteApp) and the schedule-toggle-on
   *  path (a CronJob has no workers at all). */
  private async pruneQueueScaling(namespace: string, name: string, keep: Set<string>): Promise<void> {
    const sel = encodeURIComponent(`drop.dev/workload=${name},drop.dev/process`);
    const so = await this.call("GET", `/apis/keda.sh/v1alpha1/namespaces/${namespace}/scaledobjects?labelSelector=${sel}`);
    if (so.status < 300) {
      for (const o of (JSON.parse(so.body).items ?? []) as any[]) {
        const on = o.metadata?.name as string | undefined;
        if (on && !keep.has(on)) await this.call("DELETE", this.scaledObjectPath(namespace, on));
      }
    }
    const ta = await this.call("GET", `/apis/keda.sh/v1alpha1/namespaces/${namespace}/triggerauthentications?labelSelector=${sel}`);
    if (ta.status < 300) {
      for (const o of (JSON.parse(ta.body).items ?? []) as any[]) {
        const on = o.metadata?.name as string | undefined;
        if (on && !keep.has(on)) await this.call("DELETE", this.triggerAuthPath(namespace, on));
      }
    }
  }

  async deleteApp(namespace: string, name: string): Promise<void> {
    await this.call("DELETE", this.hsoPath(namespace, name));
    await this.call("DELETE", this.netpolPath(namespace, `${name}-allow-interceptor`));
    await this.call("DELETE", this.servicePath(namespace, name));
    await this.call("DELETE", this.secretPath(namespace, `${name}-env`));
    await this.call("DELETE", this.deploymentPath(namespace, name));
    await this.pruneWorkers(namespace, name, new Set()); // tear down every worker Deployment too
    await this.pruneQueueScaling(namespace, name, new Set()); // (L1b) and their ScaledObjects/TriggerAuthentications
    await this.deleteReleaseJobs(namespace, name); // and any release Jobs left for log retrieval
    await this.deleteCronJob(namespace, name); // (H2) and the CronJob (+ its spawned Jobs), if this was a cron app
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
    await this.call("DELETE", this.secretPath(namespace, `${name}-app`)); // platform-owned creds (bootstrap.initdb + password rotation)
    await this.call("DELETE", this.secretPath(namespace, PWSET_SECRET(name))); // reap a crash-orphaned rotation Secret
  }

  // --- (I2) managed cache (Valkey) -------------------------------------------------------------
  private pvcPath = (ns: string, n: string) => `/api/v1/namespaces/${ns}/persistentvolumeclaims/${n}`;

  async applyCache(namespace: string, name: string, m: CacheManifests): Promise<void> {
    // requirepass Secret + PVC (when persistent) FIRST — the Deployment's secretKeyRef/volume resolve
    // at pod start. The Secret is emitted only at create (m.secret); on a re-apply it already exists.
    if (m.secret) await this.apply(this.secretPath(namespace, this.objName(m.secret)), m.secret as Record<string, unknown>);
    if (m.pvc) await this.apply(this.pvcPath(namespace, this.objName(m.pvc)), m.pvc as Record<string, unknown>);
    await this.apply(this.deploymentPath(namespace, name), m.deployment as Record<string, unknown>);
    await this.apply(this.servicePath(namespace, name), m.service as Record<string, unknown>);
  }

  async deleteCache(namespace: string, name: string): Promise<void> {
    await this.call("DELETE", this.servicePath(namespace, name));
    await this.call("DELETE", this.deploymentPath(namespace, name));
    await this.call("DELETE", this.secretPath(namespace, `${name}-cache`));
    // A cache delete ALWAYS wipes data — there is no cache backup; drop the PVC too (404 if ephemeral).
    await this.call("DELETE", this.pvcPath(namespace, `${name}-cache-data`));
  }

  async getCacheStatus(namespace: string, name: string): Promise<AppStatus | null> {
    // A cache is a plain Deployment labelled like an app (app.kubernetes.io/name=<name>) — reuse the
    // app-status path verbatim (replicas/ready + the pod restart/crash reason).
    return this.getAppStatus(namespace, name);
  }

  async readCachePassword(namespace: string, name: string): Promise<string | null> {
    const r = await this.call("GET", this.secretPath(namespace, `${name}-cache`));
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`readCachePassword ${name} -> ${r.status}`);
    const b64 = ((JSON.parse(r.body).data ?? {}) as Record<string, string>).password;
    return b64 ? Buffer.from(b64, "base64").toString("utf8") : null;
  }

  // --- (K1) managed auth resource (GoTrue engine) ----------------------------------------------
  async applyAuth(namespace: string, name: string, m: AuthManifests): Promise<void> {
    // The engine registers an HTTPScaledObject — fail fast on a cluster without the KEDA HTTP add-on
    // rather than orphan the Deployment/Service/keys Secret (same posture as applyApp).
    await this.assertCrd("http.keda.sh");
    // Keys Secret FIRST (the Deployment's secretKeyRef resolves at pod start). Emitted only at
    // create/rotate (m.keysSecret); on a plain re-apply it already exists and is left untouched.
    if (m.keysSecret) await this.apply(this.secretPath(namespace, this.objName(m.keysSecret)), m.keysSecret as Record<string, unknown>);
    await this.apply(this.deploymentPath(namespace, name), m.deployment as Record<string, unknown>);
    await this.apply(this.servicePath(namespace, name), m.service as Record<string, unknown>);
    await this.apply(this.netpolPath(namespace, this.objName(m.ingressPolicy)), m.ingressPolicy as Record<string, unknown>);
    await this.apply(this.hsoPath(namespace, name), m.httpScaledObject as Record<string, unknown>);
  }

  async deleteAuth(namespace: string, name: string): Promise<void> {
    await this.call("DELETE", this.hsoPath(namespace, name));
    await this.call("DELETE", this.netpolPath(namespace, `${name}-allow-interceptor`));
    await this.call("DELETE", this.servicePath(namespace, name));
    await this.call("DELETE", this.deploymentPath(namespace, name));
    await this.call("DELETE", this.secretPath(namespace, `${name}-auth-keys`)); // write-only JWT secret
    // The provider `<name>-secret` is app-secret material — torn down via the SecretStore (like an app).
  }

  async getAuthStatus(namespace: string, name: string): Promise<AppStatus | null> {
    // The engine is a plain Deployment labelled like an app (app.kubernetes.io/name=<name>) — reuse the
    // app-status path verbatim.
    return this.getAppStatus(namespace, name);
  }

  async readAuthJwtSecret(namespace: string, name: string): Promise<string | null> {
    const r = await this.call("GET", this.secretPath(namespace, `${name}-auth-keys`));
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`readAuthJwtSecret ${name} -> ${r.status}`);
    const b64 = ((JSON.parse(r.body).data ?? {}) as Record<string, string>)["jwt-secret"];
    return b64 ? Buffer.from(b64, "base64").toString("utf8") : null;
  }

  // --- (I3) CNPG Pooler (PgBouncer connection pooling) ------------------------------------------
  private poolerPath = (ns: string, n: string) => `/apis/postgresql.cnpg.io/v1/namespaces/${ns}/poolers/${n}`;
  async applyPooler(namespace: string, manifest: Record<string, unknown>): Promise<void> {
    await this.assertCrd("postgresql.cnpg.io"); // the CNPG operator serves the Pooler CRD
    await this.apply(this.poolerPath(namespace, this.objName(manifest)), manifest);
  }
  async deletePooler(namespace: string, dbName: string): Promise<void> {
    await this.call("DELETE", this.poolerPath(namespace, poolerName(dbName)));
  }
  async getPooler(namespace: string, dbName: string): Promise<{ mode: string } | null> {
    const r = await this.call("GET", this.poolerPath(namespace, poolerName(dbName)));
    if (r.status >= 300) return null;
    const mode = (JSON.parse(r.body).spec?.pgbouncer?.poolMode as string) || "transaction";
    return { mode };
  }

  // --- generic per-key Secret mutations (used by KubeSecretStore for app secrets) ---
  // MERGE-patch, NOT server-side-apply: a merge-patch adds/updates exactly the named key and leaves
  // the others intact, so setting one secret never prunes the rest (SSA would). JSON-merge `null`
  // deletes a key. These are write-path only — no method ever returns a value.

  /** Create-or-update one key in a Secret (create the Opaque Secret if it doesn't exist yet). */
  async ensureSecretKey(namespace: string, name: string, key: string, value: string): Promise<void> {
    const body = JSON.stringify({ stringData: { [key]: value } });
    const r = await this.call("PATCH", this.secretPath(namespace, name), { body, contentType: "application/merge-patch+json" });
    if (r.status === 404) {
      const create = await this.call("POST", `/api/v1/namespaces/${namespace}/secrets`, {
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          type: "Opaque",
          metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "drop", "app.kubernetes.io/name": name } },
          stringData: { [key]: value },
        }),
        contentType: "application/json",
      });
      if (create.status === 409) return void (await this.ensureSecretKey(namespace, name, key, value)); // raced — retry the patch
      if (create.status >= 300) throw new Error(`create secret ${name} -> ${create.status}: ${create.body.slice(0, 200)}`);
      return;
    }
    if (r.status >= 300) throw new Error(`patch secret ${name} -> ${r.status}: ${r.body.slice(0, 200)}`);
  }

  /** Remove one key from a Secret. Idempotent (absent Secret/key → no-op). */
  async removeSecretKey(namespace: string, name: string, key: string): Promise<void> {
    const r = await this.call("PATCH", this.secretPath(namespace, name), {
      body: JSON.stringify({ data: { [key]: null } }), // JSON-merge null deletes the key
      contentType: "application/merge-patch+json",
    });
    if (r.status === 404) return;
    if (r.status >= 300) throw new Error(`remove secret key ${name}/${key} -> ${r.status}`);
  }

  /** Key NAMES present in a Secret (never values). Empty if the Secret is absent. */
  async listSecretDataKeys(namespace: string, name: string): Promise<string[]> {
    const r = await this.call("GET", this.secretPath(namespace, name));
    if (r.status === 404) return [];
    if (r.status >= 300) throw new Error(`get secret ${name} -> ${r.status}`);
    return Object.keys((JSON.parse(r.body).data ?? {}) as Record<string, string>).sort();
  }

  /** Delete a whole Secret object. Safe if absent. */
  async deleteSecretObject(namespace: string, name: string): Promise<void> {
    await this.call("DELETE", this.secretPath(namespace, name));
  }

  // --- External Secrets Operator ExternalSecret (aws/gcp/azure/vault secret injection) ---
  private externalSecretPath = (ns: string, n: string) => `/apis/external-secrets.io/v1/namespaces/${ns}/externalsecrets/${n}`;
  async applyExternalSecret(namespace: string, name: string, obj: Record<string, unknown>): Promise<void> {
    await this.apply(this.externalSecretPath(namespace, name), obj); // SSA: data list = exactly the current keys
  }
  async deleteExternalSecret(namespace: string, name: string): Promise<void> {
    await this.call("DELETE", this.externalSecretPath(namespace, name));
  }

  private podsPath = (ns: string, n: string) =>
    `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${n}`)}`;

  // G2: a `schedule` (cron) app has NO Deployment, so this — and listNamespaceAppStatuses /
  // listAppProcesses, all Deployment-keyed — degrade to null/empty for it (never throw); the API's
  // normalizeStatus turns a null AppStatus into {status:"progressing", reason:"status unavailable"},
  // which is an honest v1 read for a workload whose "runs" are point-in-time Jobs, not a steady-state
  // Deployment. Surfacing actual cron RUN history (last N fires, success/failure, duration) is a
  // metrics-slice concern, deferred.
  async getAppStatus(namespace: string, name: string): Promise<AppStatus | null> {
    const r = await this.call("GET", this.deploymentPath(namespace, name));
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`getAppStatus ${name} -> ${r.status}`);
    const s = (JSON.parse(r.body).status ?? {}) as { replicas?: number; readyReplicas?: number };
    // Restarts + crash reason come from the PODS (the Deployment status has neither).
    const { restarts, reason } = await this.podRestartsReason(namespace, name, s.replicas ?? 0);
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

  /** One `follow=true` log GET against a specific pod. Resolves the raw response stream on a 2xx,
   *  or null on any non-2xx/connection error (so the caller can retry, e.g. without a container
   *  filter). `signal` aborts the underlying request/connection at any point — before OR during
   *  the stream — so a client disconnect never leaks the upstream socket. */
  private openLogStream(namespace: string, pod: string, tailLines: number, container: string | undefined, signal?: AbortSignal): Promise<Readable | null> {
    const qs = new URLSearchParams({ follow: "true", tailLines: String(tailLines) });
    if (container) qs.set("container", container);
    const u = new URL(`${this.conn.server}/api/v1/namespaces/${namespace}/pods/${pod}/log?${qs}`);
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(null);
      const req = request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          ca: this.conn.ca,
          cert: this.conn.cert,
          key: this.conn.key,
          headers: { ...(this.conn.token ? { authorization: `Bearer ${this.conn.token}` } : {}) },
        },
        (res) => {
          if ((res.statusCode ?? 0) >= 300) {
            res.resume(); // drain so the socket closes cleanly instead of hanging half-read
            resolve(null);
            return;
          }
          resolve(res);
        },
      );
      req.on("error", () => resolve(null)); // nothing more specific to retry — caller surfaces "no logs"
      if (signal) signal.addEventListener("abort", () => req.destroy(), { once: true });
      req.end();
    });
  }

  async getWorkloadLogsStream(namespace: string, name: string, opts: { tailLines?: number; signal?: AbortSignal } = {}): Promise<Readable | null> {
    const tail = opts.tailLines ?? 100;
    for (const sel of [`app.kubernetes.io/name=${name}`, `cnpg.io/cluster=${name},cnpg.io/instanceRole=primary`]) {
      const pr = await this.call("GET", `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(sel)}`);
      if (pr.status >= 300) continue;
      const pods = (JSON.parse(pr.body).items ?? []) as any[];
      if (!pods.length) continue;
      // v1: follow the FIRST READY pod only (see KubeClient.getWorkloadLogsStream doc) — no
      // multiplexing across a multi-pod app's replicas.
      const target = pods.find((p) => (p.status?.containerStatuses ?? []).some((cs: any) => cs.ready)) ?? pods[0];
      const pod = target.metadata.name as string;
      // container=name may 404 for CNPG (container is "postgres"); retry without the filter.
      const withContainer = await this.openLogStream(namespace, pod, tail, name, opts.signal);
      if (withContainer) return withContainer;
      return await this.openLogStream(namespace, pod, tail, undefined, opts.signal);
    }
    return null;
  }

  /** (J3) Open an interactive exec stream into an app's first ready pod. Resolves the pod the SAME way
   *  as getWorkloadLogsStream (app label, prefer a ready pod), then opens the v4.channel.k8s.io
   *  WebSocket against the API server (src/kube/exec.ts) with the SAME cert/token auth `call` uses.
   *  Returns null if no pod is found. The container filter is `<app>` (an app's container is named for
   *  the app, exactly as the logs path assumes). */
  async openExec(namespace: string, name: string, command: string[], opts: { tty?: boolean } = {}): Promise<KubeExecSession | null> {
    const pr = await this.call("GET", `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${name}`)}`);
    if (pr.status >= 300) return null;
    const pods = (JSON.parse(pr.body).items ?? []) as any[];
    if (!pods.length) return null;
    const target = pods.find((p) => (p.status?.containerStatuses ?? []).some((cs: any) => cs.ready)) ?? pods[0];
    const pod = target.metadata.name as string;
    const qs = new URLSearchParams();
    for (const arg of command) qs.append("command", arg); // repeated ?command= per argv element
    qs.set("container", name);
    qs.set("stdin", "true");
    qs.set("stdout", "true");
    qs.set("stderr", "true");
    qs.set("tty", opts.tty ? "true" : "false");
    return openKubeExecStream(this.conn, `/api/v1/namespaces/${namespace}/pods/${pod}/exec?${qs.toString()}`);
  }

  /** Recent restart count + crash reason for a Deployment's pods (Deployment .status has neither). */
  private async podRestartsReason(namespace: string, deploymentName: string, replicas: number): Promise<{ restarts: number; reason: string }> {
    try {
      const pr = await this.call("GET", this.podsPath(namespace, deploymentName));
      if (pr.status < 300) return reasonFromPods((JSON.parse(pr.body).items ?? []) as any[], deploymentName, replicas);
    } catch {
      /* leave restarts/reason at defaults */
    }
    return { restarts: 0, reason: replicas === 0 ? "ScaledToZero" : "NoPods" };
  }

  /** Live status of every app (web Deployment) in a namespace — ONE Deployments list + ONE pods list,
   *  grouped in-process, so the stack graph reads N apps with 2 calls (C1). Worker Deployments
   *  (labelled drop.dev/process) and non-drop Deployments are skipped; a non-2xx degrades to {}. */
  async listNamespaceAppStatuses(namespace: string): Promise<Record<string, AppStatus>> {
    const out: Record<string, AppStatus> = {};
    const dr = await this.call("GET", `/apis/apps/v1/namespaces/${namespace}/deployments`);
    if (dr.status >= 300) return out;
    const deploys = (JSON.parse(dr.body).items ?? []) as any[];
    const podsByApp = new Map<string, any[]>();
    const pr = await this.call("GET", `/api/v1/namespaces/${namespace}/pods`);
    if (pr.status < 300) {
      for (const p of (JSON.parse(pr.body).items ?? []) as any[]) {
        const app = p.metadata?.labels?.["app.kubernetes.io/name"];
        if (!app) continue;
        const list = podsByApp.get(app);
        if (list) list.push(p);
        else podsByApp.set(app, [p]);
      }
    }
    for (const dep of deploys) {
      const labels = dep.metadata?.labels ?? {};
      const app = labels["app.kubernetes.io/name"] as string | undefined;
      // Only the WEB Deployment (name === app); skip worker Deployments and any non-drop object.
      if (!app || labels["drop.dev/process"] || dep.metadata?.name !== app) continue;
      const s = (dep.status ?? {}) as { replicas?: number; readyReplicas?: number };
      const replicas = s.replicas ?? 0;
      const { restarts, reason } = reasonFromPods(podsByApp.get(app) ?? [], app, replicas);
      out[app] = { replicas, ready: s.readyReplicas ?? 0, restarts, reason };
    }
    return out;
  }

  /** Live status of every managed database (CNPG Cluster) in a namespace — ONE Clusters list (C1).
   *  A non-2xx (CNPG absent / compute off) degrades to {}. */
  async listNamespaceDatabaseStatuses(namespace: string): Promise<Record<string, DatabaseStatus>> {
    const out: Record<string, DatabaseStatus> = {};
    const r = await this.call("GET", `/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters`);
    if (r.status >= 300) return out;
    for (const o of (JSON.parse(r.body).items ?? []) as any[]) {
      const name = o.metadata?.name as string | undefined;
      if (!name) continue;
      const hibernated = o.metadata?.annotations?.["cnpg.io/hibernation"] === "on";
      out[name] = { phase: o.status?.phase ?? "unknown", ready: o.status?.readyInstances ?? 0, instances: o.spec?.instances ?? 0, hibernated };
    }
    return out;
  }

  private releaseSelector = (name: string) => encodeURIComponent(`drop.dev/workload=${name},drop.dev/job=release`);

  async runReleaseJob(namespace: string, name: string, job: Record<string, unknown>, timeoutMs: number): Promise<ReleaseResult> {
    const jobName = (job.metadata as { name: string }).name;
    const jp = this.jobPath(namespace, jobName);
    await this.apply(jp, job); // priors were GC'd by deleteReleaseJobs; this name is version-unique
    // Poll to a terminal state, bounded by the caller's timeout. backoffLimit:0 → a single failure
    // (failed>=1) is terminal. Never throw on failure — return ok:false + logs so the deploy halts
    // cleanly and surfaces the migration output.
    const deadline = Date.now() + timeoutMs;
    let reason: ReleaseResult["reason"] = "timeout";
    while (Date.now() < deadline) {
      await sleep(2000);
      const r = await this.call("GET", jp);
      if (r.status >= 300) continue;
      const st = (JSON.parse(r.body).status ?? {}) as { succeeded?: number; failed?: number; conditions?: { type: string; status: string }[] };
      if (st.succeeded && st.succeeded >= 1) { reason = "succeeded"; break; }
      if ((st.conditions ?? []).some((c) => c.type === "Failed" && c.status === "True") || (st.failed ?? 0) >= 1) { reason = "failed"; break; }
    }
    const logs = await this.getReleaseLogs(namespace, name, 200).catch(() => "");
    return { ok: reason === "succeeded", reason, logs };
  }

  async deleteReleaseJobs(namespace: string, name: string): Promise<void> {
    const r = await this.call("GET", `/apis/batch/v1/namespaces/${namespace}/jobs?labelSelector=${this.releaseSelector(name)}`);
    if (r.status >= 300) return;
    for (const j of (JSON.parse(r.body).items ?? []) as any[]) {
      const jn = j.metadata?.name as string | undefined;
      if (jn) await this.call("DELETE", `${this.jobPath(namespace, jn)}?propagationPolicy=Foreground`);
    }
  }

  async getReleaseLogs(namespace: string, name: string, tailLines = 200): Promise<string> {
    const pr = await this.call("GET", `/api/v1/namespaces/${namespace}/pods?labelSelector=${this.releaseSelector(name)}`);
    if (pr.status >= 300) return "";
    const pods = (JSON.parse(pr.body).items ?? []) as any[];
    if (!pods.length) return "";
    // newest release pod (a fresh deploy's Job is the current one after the pre-deploy GC)
    pods.sort((a, b) => ((a.metadata?.creationTimestamp ?? "") < (b.metadata?.creationTimestamp ?? "") ? 1 : -1));
    const pod = pods[0].metadata.name as string;
    const lr = await this.call("GET", `/api/v1/namespaces/${namespace}/pods/${pod}/log?tailLines=${tailLines}`);
    return lr.status < 300 ? lr.body : "";
  }

  async listAppProcesses(namespace: string, name: string): Promise<ProcessStatus[]> {
    const sel = encodeURIComponent(`app.kubernetes.io/managed-by=drop,drop.dev/workload=${name}`);
    const r = await this.call("GET", `/apis/apps/v1/namespaces/${namespace}/deployments?labelSelector=${sel}`);
    if (r.status >= 300) return [];
    const out: ProcessStatus[] = [];
    for (const d of (JSON.parse(r.body).items ?? []) as any[]) {
      const dn = d.metadata?.name as string;
      // the web Deployment is named `<app>` and carries no drop.dev/process label.
      const process = (d.metadata?.labels?.["drop.dev/process"] as string) ?? "web";
      const web = process === "web" || dn === name;
      const s = (d.status ?? {}) as { replicas?: number; readyReplicas?: number };
      const { restarts, reason } = await this.podRestartsReason(namespace, dn, s.replicas ?? 0);
      out.push({ name: dn, process, web, replicas: s.replicas ?? 0, ready: s.readyReplicas ?? 0, restarts, reason });
    }
    return out;
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

  // --- app lifecycle: restart / stop (true-offline) / start ---

  async restartApp(namespace: string, name: string, restartedAt: string): Promise<void> {
    const r = await this.call("PATCH", this.deploymentPath(namespace, name), {
      body: JSON.stringify({ spec: { template: { metadata: { annotations: { "drop.dev/restartedAt": restartedAt } } } } }),
      contentType: "application/merge-patch+json",
    });
    if (r.status === 404) throw new Error(`no such app: ${name}`);
    if (r.status >= 300) throw new Error(`restartApp ${name} -> ${r.status}: ${r.body.slice(0, 200)}`);
  }

  async stopApp(namespace: string, name: string): Promise<void> {
    // (H2) A cron app has no Deployment/KEDA ScaledObject to pause — "stopped" means SUSPENDING the
    // CronJob instead (no new Job runs fire; a run already in flight is untouched). Try this FIRST:
    // a 404 means there's no CronJob by this name, i.e. it's an ordinary app — fall through to the
    // existing Deployment/KEDA path below.
    const cj = await this.call("PATCH", this.cronJobPath(namespace, name), {
      body: JSON.stringify({ spec: { suspend: true } }),
      contentType: "application/merge-patch+json",
    });
    if (cj.status < 300) return;
    if (cj.status !== 404) throw new Error(`stopApp ${name}: suspend cron -> ${cj.status}`);

    // Pause KEDA: paused-replicas:0 pins the workload at 0 AND makes KEDA ignore the HTTP scaler,
    // so traffic to the interceptor can't wake it — true offline. KEDA creates the ScaledObject
    // asynchronously from the HTTPScaledObject, so on a (re)deploy it may not exist yet — retry
    // until it does, or the app could wake on traffic before the pause lands.
    let paused = false;
    for (let i = 0; i < 15; i++) {
      const so = await this.call("PATCH", this.scaledObjectPath(namespace, name), {
        body: JSON.stringify({ metadata: { annotations: { "autoscaling.keda.sh/paused-replicas": "0" } } }),
        contentType: "application/merge-patch+json",
      });
      if (so.status < 300) { paused = true; break; }
      if (so.status !== 404) throw new Error(`stopApp ${name}: pause -> ${so.status}`);
      await sleep(2000); // ScaledObject not created yet — wait for KEDA's reconcile
    }
    // Scale the Deployment to 0 now so it goes down immediately (KEDA keeps it there while paused).
    const dp = await this.call("PATCH", this.deploymentPath(namespace, name), {
      body: JSON.stringify({ spec: { replicas: 0 } }),
      contentType: "application/merge-patch+json",
    });
    if (dp.status === 404) throw new Error(`no such app: ${name}`);
    if (dp.status >= 300) throw new Error(`stopApp ${name}: scale -> ${dp.status}`);
    if (!paused) throw new Error(`stopApp ${name}: KEDA ScaledObject never appeared — not paused, may wake on traffic`);
  }

  async startApp(namespace: string, name: string): Promise<void> {
    // (H2) Mirror stopApp: try un-suspending a CronJob first; a 404 means it's an ordinary app.
    const cj = await this.call("PATCH", this.cronJobPath(namespace, name), {
      body: JSON.stringify({ spec: { suspend: false } }),
      contentType: "application/merge-patch+json",
    });
    if (cj.status < 300) return;
    if (cj.status !== 404) throw new Error(`startApp ${name}: unsuspend cron -> ${cj.status}`);

    // Remove the pause annotation → KEDA resumes scaling per the HTTPScaledObject (0..max on traffic).
    const so = await this.call("PATCH", this.scaledObjectPath(namespace, name), {
      body: JSON.stringify({ metadata: { annotations: { "autoscaling.keda.sh/paused-replicas": null } } }),
      contentType: "application/merge-patch+json",
    });
    if (so.status === 404) throw new Error(`no such app: ${name}`);
    if (so.status >= 300) throw new Error(`startApp ${name}: unpause -> ${so.status}`);
  }

  async getTenantUsage(namespace: string): Promise<TenantUsage | null> {
    const r = await this.call("GET", this.quotaPath(namespace, "drop-quota"));
    if (r.status === 404) return null; // namespace/quota not provisioned (static-only tenant)
    if (r.status >= 300) throw new Error(`getTenantUsage ${namespace} -> ${r.status}`);
    const s = (JSON.parse(r.body).status ?? {}) as { hard?: Record<string, string>; used?: Record<string, string> };
    return { hard: s.hard ?? {}, used: s.used ?? {} };
  }

  async getDatabaseStatus(namespace: string, name: string): Promise<DatabaseStatus | null> {
    const r = await this.call("GET", this.clusterPath(namespace, name));
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`getDatabaseStatus ${name} -> ${r.status}`);
    const o = JSON.parse(r.body) as { metadata?: { annotations?: Record<string, string> }; status?: { phase?: string; readyInstances?: number }; spec?: { instances?: number } };
    const hibernated = o.metadata?.annotations?.["cnpg.io/hibernation"] === "on";
    return { phase: o.status?.phase ?? "unknown", ready: o.status?.readyInstances ?? 0, instances: o.spec?.instances ?? 0, hibernated };
  }

  async listDatabaseBackups(namespace: string, name: string): Promise<BackupInfo[]> {
    const sel = encodeURIComponent(`cnpg.io/cluster=${name}`);
    const r = await this.call("GET", `/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/backups?labelSelector=${sel}`);
    if (r.status === 404) return [];
    if (r.status >= 300) throw new Error(`listDatabaseBackups ${name} -> ${r.status}`);
    const items = (JSON.parse(r.body).items ?? []) as any[];
    return items
      .map((b) => ({
        name: b.metadata?.name as string,
        phase: (b.status?.phase as string) ?? "unknown",
        method: (b.spec?.method as string) ?? null,
        startedAt: (b.status?.startedAt as string) ?? null,
        stoppedAt: (b.status?.stoppedAt as string) ?? null,
        error: (b.status?.error as string) ?? null,
        _ord: (b.status?.startedAt as string) ?? (b.metadata?.creationTimestamp as string) ?? "",
      }))
      .sort((a, b) => (a._ord < b._ord ? 1 : -1)) // newest first
      .map(({ _ord, ...rest }) => rest);
  }

  async triggerDatabaseBackup(namespace: string, name: string, backupName: string): Promise<void> {
    const cr = await this.call("GET", this.clusterPath(namespace, name));
    if (cr.status === 404) throw new Error(`no such database: ${name}`);
    if (cr.status >= 300) throw new Error(`triggerDatabaseBackup ${name}: cluster read -> ${cr.status}`);
    await this.apply(this.backupPath(namespace, backupName), databaseBackupManifest({ name: backupName, cluster: name, namespace, storeName: `${name}-store` }));
  }

  async hibernateDatabase(namespace: string, name: string): Promise<void> {
    await this.setHibernation(namespace, name, "on");
  }
  async wakeDatabase(namespace: string, name: string): Promise<void> {
    await this.setHibernation(namespace, name, "off");
  }
  private async setHibernation(namespace: string, name: string, value: "on" | "off"): Promise<void> {
    const r = await this.call("PATCH", this.clusterPath(namespace, name), {
      body: JSON.stringify({ metadata: { annotations: { "cnpg.io/hibernation": value } } }),
      contentType: "application/merge-patch+json",
    });
    if (r.status === 404) throw new Error(`no such database: ${name}`);
    if (r.status >= 300) throw new Error(`hibernation ${value} ${name} -> ${r.status}: ${r.body.slice(0, 200)}`);
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
