// Pure translator: AppConfig (+ tenant) → the Kubernetes objects that run it. No
// cluster access here — a deterministic mapping the API applies via a KubeClient.
// v1 is 443-only (one HTTP service); scaling is owned by the KEDA HTTP Add-on
// (HTTPScaledObject), so the Deployment intentionally omits spec.replicas.
import { type AppConfig, type AppResources, type ExpandedProcess, assertHttpOnly, assertProcesses, expandProcesses } from "../app-config.ts";
import { cacheHost } from "./valkey.ts";

export interface ManifestContext {
  name: string; // claimed workload name (DNS-safe)
  namespace: string; // tenant namespace
  host: string; // <name>.<baseDomain> — the registered HTTPScaledObject host
  sandbox?: boolean; // run under the gVisor RuntimeClass (untrusted tenants; prod only)
  imagePullSecret?: string; // name of an imagePullSecret in the tenant ns (registry image backend; omit for local containerd-import + IRSA)
  // (H1) Stamped onto the pod template as the `drop.dev/version` annotation on EVERY deploy AND
  // rollback. Server-side apply only rolls pods when the Deployment's pod template actually
  // changes — an unchanged image tag (a same-tag redeploy, or a rollback to a version whose image
  // matches what's currently running) would otherwise silently no-op. A version id is always
  // unique, so stamping it here guarantees the template differs and kube rolls the pods.
  versionId?: string;
  // (A2b) The app has a TCP expose row, so its `services[].protocol: tcp` is intentional — skip the
  // v1 assertHttpOnly guard (which otherwise 400s a non-HTTP service). The rest of the shape is
  // unchanged: the Service still fronts the container port and the HTTPScaledObject keeps scale.min
  // (≥1 for a TCP app) replicas alive; edge-tcp routes to the Service out of band.
  tcpExposed?: boolean;
  // (H3) app→app service-discovery env: already-RESOLVED `<KEY>_URL` container env vars (an in-cluster
  // Service URL for an always-on target, or its public wake host for a scale-to-zero one — see
  // appUseUrl). The reconciler resolves these (it knows each target's namespace + live scale) and hands
  // them in; the manifest layer just appends them as PLAIN container env (a Service URL is not a secret).
  appUrlEnv?: { name: string; value: string }[];
  // (E2) App preview read-only secret reuse: when set, the pod's `envFrom` references the PARENT's
  // `<sharedSecretName>-env` (config) + `<sharedSecretName>-secret` (write-only app secrets: REDIS_URL /
  // S3_* / AUTH_*) instead of the preview's own `<name>-…` copies — so a preview NEVER gets its own
  // secret set, it reads the parent's. It ALSO suppresses emitting a per-preview `-env` Secret (the
  // preview shares the parent's), which keeps applyApp(`<name>-p-<label>`) from ever writing the parent's
  // `<parent>-env`. Absent for a normal deploy (secrets keyed on the workload's own name).
  sharedSecretName?: string;
}
export interface WorkerManifests {
  name: string; // Deployment name: `<app>-<process>`
  process: string; // the process key
  deployment: Record<string, unknown>; // plain Deployment (no Service / HTTPScaledObject)
  // (L1b) Present only when this worker declares `scale_on` — assertProcesses already guarantees the
  // app has a `{cache}` binding to point at before appManifests ever builds these. A KEDA core
  // `ScaledObject` (redis-lists trigger on the bound Valkey) + the `TriggerAuthentication` it
  // references for the cache's password. Named the SAME as the worker Deployment (`w.name`) — legal
  // since they're different API kinds, and it keeps client.ts's prune-by-keep-set logic trivial (one
  // name, three kinds to reconcile: Deployment, ScaledObject, TriggerAuthentication).
  scaledObject?: Record<string, unknown>;
  triggerAuth?: Record<string, unknown>;
}
export interface AppManifests {
  // The WEB process objects (named `<app>`). Absent for a worker-only app — a legal shape now that
  // `processes:` exists (`drop deploy` with no `web` process). Existing single-process apps are
  // unchanged: `deployment`/`service`/`httpScaledObject`/`ingressPolicy` are the web process's.
  deployment?: Record<string, unknown>;
  service?: Record<string, unknown>;
  httpScaledObject?: Record<string, unknown>;
  ingressPolicy?: Record<string, unknown>; // let the KEDA interceptor reach the web pods
  secret?: Record<string, unknown>; // env (omitted when the app has no env) — shared by every process
  workers?: WorkerManifests[]; // extra worker Deployments (omitted when the app is web-only)
  // (I5) One PersistentVolumeClaim (`<name>-data`, RWO) — present only when `app.stateful` is set.
  // assertProcesses guarantees a stateful app has no workers, so this is always the WEB process's volume.
  pvc?: Record<string, unknown>;
  // (H2) `schedule` → a CronJob instead of everything above: when set, deployment/service/
  // httpScaledObject/ingressPolicy/workers are ALL absent (a cron app has no web/worker processes —
  // assertProcesses refuses schedule alongside processes/an explicit services/healthcheck before we
  // ever get here). `secret` (the shared `<name>-env` config Secret) is unaffected — it's still
  // emitted when the app has env, same as the web/worker shape.
  cronJob?: Record<string, unknown>;
}
export interface TenantManifests {
  namespace: Record<string, unknown>;
  networkPolicy: Record<string, unknown>;
  resourceQuota: Record<string, unknown>;
  limitRange: Record<string, unknown>;
  // (A2b) One "allow from edge-tcp" NetworkPolicy per EXPOSED workload — EMPTY unless the tenant has
  // TCP-exposed workloads. Kept as separate per-workload policies (not folded into the default-deny)
  // precisely so the allow is scoped to ONLY the exposed pod: a single default-deny policy selects all
  // pods (podSelector {}), so an ingress rule on it would open edge-tcp → every pod in the namespace.
  // applyTenant applies these + prunes any left from a since-unexposed workload (label drop.dev/allow).
  edgeTcpPolicies: Record<string, unknown>[];
}

/** An exposed workload passed into tenantManifests to build its "allow from edge-tcp" rule. `kind`
 *  picks the destination pod selector (app → app.kubernetes.io/name; database → cnpg.io/cluster);
 *  `port` is the container port edge-tcp is permitted to reach on that pod. */
export interface ExposedWorkload {
  name: string;
  kind: "app" | "database";
  port: number;
}

const SERVICE_PORT = 80;
const KEDA_NAMESPACE = "keda"; // where the KEDA HTTP add-on interceptor runs

// ---- (H3) app→app service discovery ------------------------------------------------------------------
/** The env-var an app→app edge injects into the consumer: `<KEY>_URL` (KEY = the used resource's key /
 *  app name, uppercased; non-alnum → `_`). Matches the bucket/cache/auth env-key casing convention. */
export function appUseEnvName(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_URL";
}
/** Resolve an app→app edge's target URL from the target's live scale floor.
 *  - An always-on target (`minReplicas ≥ 1`) is reachable directly in-cluster at its Service — the
 *    lowest-latency path, and the tenant default-deny NetworkPolicy already permits intra-namespace
 *    traffic (no hole to open).
 *  - A scale-to-zero target (`minReplicas < 1`) has no pod to dial, so we point at its PUBLIC host: the
 *    call hairpins back through the edge → KEDA HTTP interceptor (the same wake path external traffic
 *    takes), which scales the target up on first hit. This costs an external round-trip plus a cold
 *    start — DOCUMENTED added latency — and reaches the edge over the NetworkPolicy's existing 443
 *    egress allowance, so it opens NO cross-namespace hole (unlike dialing the in-cluster interceptor,
 *    which the default-deny would block). */
export function appUseUrl(opts: { targetName: string; namespace: string; publicHost: string; minReplicas: number }): string {
  return opts.minReplicas >= 1
    ? `http://${opts.targetName}.${opts.namespace}.svc.cluster.local:${SERVICE_PORT}`
    : `https://${opts.publicHost}`;
}
// (A2b) The component label the edge-tcp router pods carry — the source selector every tenant
// "allow from edge-tcp" NetworkPolicy matches on (see edgeTcpAllowPolicy + edgeTcpManifests).
const EDGE_TCP_COMPONENT = "edge-tcp";

// Where a bound database's CNPG cluster CA (`ca.crt` from the `<db>-ca` Secret) is mounted,
// read-only, one dir per database: `<base>/<db>/ca.crt`. PGSSLROOTCERT points the primary
// binding at it so the app can verify-full the server's TLS cert.
const DB_CA_MOUNT_BASE = "/var/run/drop/db-ca";

/** (B1 reuse) The read-only CA volume + mount + resolved `ca.crt` path for a bound database. Exported
 *  so the managed-auth engine (K1) mounts the SAME `<db>-ca` Secret the same way for its verify-full
 *  Postgres connection — one source of truth for the DB-CA mechanics, shared by appBinding below. */
export function dbCaBinding(db: string): { volume: Record<string, unknown>; volumeMount: Record<string, unknown>; caCertPath: string } {
  return {
    volume: { name: `db-ca-${db}`, secret: { secretName: `${db}-ca`, items: [{ key: "ca.crt", path: "ca.crt" }] } },
    volumeMount: { name: `db-ca-${db}`, mountPath: `${DB_CA_MOUNT_BASE}/${db}`, readOnly: true },
    caCertPath: `${DB_CA_MOUNT_BASE}/${db}/ca.crt`,
  };
}

// The cloud instance-metadata endpoint — same IP on AWS/GCP/Azure, so it's always
// excluded from the egress allowlist regardless of cluster CIDRs.
const IMDS_CIDR = "169.254.169.254/32";
// Fallback in-cluster CIDR excluded from the HTTPS allowlist when none is configured.
// Matches LOCAL k3s (pod 10.42/16 + service 10.43/16, both inside 10/8). PROD EKS
// often uses pod/service CIDRs OUTSIDE 10/8 (172.16/12, 100.64/10) — the operator
// MUST override this via config (DROP_BLOCKED_EGRESS_CIDRS) or cross-tenant 443
// egress is silently left open. See tenantManifests opts.blockedEgressCidrs.
const DEFAULT_BLOCKED_EGRESS_CIDRS = ["10.0.0.0/8"];

// Per-tenant defaults (conservative caps for v1; tunable via config later).
const QUOTA = { "limits.cpu": "4", "limits.memory": "8Gi", "count/pods": "20", "count/services": "10" };
const LIMITRANGE_DEFAULT = { cpu: "0.5", memory: "512Mi" };
const LIMITRANGE_DEFAULT_REQUEST = { cpu: "100m", memory: "128Mi" };
// (I5 / Future.md item 10 parts 1-2) The tenant ResourceQuota previously had NO storage dimension at
// all — an org could stack unlimited per-database PVCs (each capped individually at MAX_DB_STORAGE) or
// stateful-app volumes with no TOTAL ceiling. These are static platform defaults (same posture as QUOTA
// above — nothing in tenantManifests is org-aware yet); a per-org override (the `storage_budget_bytes`
// admin override already resolved by QuotaStore for the control-plane budget check) would fold in here
// via `opts.storageBudget`/`opts.maxPvcs` the same way max_workloads/max_db_storage already resolve
// elsewhere — that server.ts wiring is a follow-up (see Future.md item 10), not done in this slice.
const DEFAULT_STORAGE_BUDGET = "20Gi"; // generous headroom for several 1Gi DB PVCs + one 10Gi stateful volume
const DEFAULT_MAX_PVCS = 10;

/** Per-tenant isolation objects: a PSA-labeled Namespace, a default-deny
 *  NetworkPolicy (intra-ns + DNS + an HTTPS egress allowlist that excludes the
 *  metadata IP + the in-cluster/control-plane CIDRs), a ResourceQuota, and a
 *  default LimitRange. `opts.blockedEgressCidrs` MUST cover the live cluster's
 *  pod+service CIDRs (sourced from config) — they're what keeps cross-tenant and
 *  platform-DB traffic off the 443 allowlist on clusters whose CIDRs aren't in 10/8.
 *  `opts.storageBudget`/`opts.maxPvcs` (I5) size the ResourceQuota's `requests.storage` +
 *  `count/persistentvolumeclaims` dims — static platform defaults when omitted (see above). */
export function tenantManifests(
  namespace: string,
  opts: {
    blockedEgressCidrs?: string[];
    edgeTcp?: { namespace: string; workloads: ExposedWorkload[] };
    storageBudget?: string;
    maxPvcs?: number;
  } = {},
): TenantManifests {
  const blocked = opts.blockedEgressCidrs && opts.blockedEgressCidrs.length > 0 ? opts.blockedEgressCidrs : DEFAULT_BLOCKED_EGRESS_CIDRS;
  // (I5) Folds Future.md item 10's parts 1-2 into the namespace ResourceQuota: a TOTAL `requests.storage`
  // budget across every PVC in the tenant namespace (every managed database + any stateful app volumes)
  // and a cap on the PVC COUNT — so k8s itself rejects a create that would blow past either, on top of
  // the control-plane's own storage_budget_bytes check (server.ts, item 10) that runs earlier.
  const quota = { ...QUOTA, "requests.storage": opts.storageBudget ?? DEFAULT_STORAGE_BUDGET, "count/persistentvolumeclaims": String(opts.maxPvcs ?? DEFAULT_MAX_PVCS) };
  const labels = {
    "app.kubernetes.io/managed-by": "drop",
    "pod-security.kubernetes.io/enforce": "baseline",
    "pod-security.kubernetes.io/warn": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
  };
  return {
    namespace: { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels } },
    networkPolicy: {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "drop-default-deny", namespace },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        // (H3) These two intra-namespace rules are exactly what makes app→app service discovery work
        // with NO extra policy: a consumer app reaches an always-on peer's `<KEY>_URL`
        // (`<peer>.<ns>.svc:80`) over the intra-namespace ingress/egress below. A CROSS-namespace (cross-
        // org) peer is unreachable here — which IS the H3 refusal, enforced up front in the reconciler.
        // The scale-to-zero wake host (`https://<peer>.<baseDomain>`) rides the 443 egress rule further down.
        ingress: [{ from: [{ podSelector: {} }] }], // intra-namespace ingress only (interceptor allowed per-app)
        egress: [
          { to: [{ podSelector: {} }] }, // intra-namespace (incl. the tenant's own DB + H3 peer apps)
          { to: [{ namespaceSelector: {} }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }, // DNS
          {
            // Default-deny (above) already blocks ALL egress except intra-namespace +
            // DNS — so cross-tenant pods/Services on other ports, the in-cluster API,
            // and IMDS over port 80 are unreachable irrespective of this rule. This rule
            // re-opens ONLY outbound HTTPS to the public internet and EXCLUDES the cloud
            // metadata IP + the config-driven in-cluster/control-plane CIDRs, so an app
            // still can't reach the platform DB or another tenant over 443. `blocked`
            // MUST cover the live pod+service CIDRs (on EKS those are often NOT in 10/8).
            to: [{ ipBlock: { cidr: "0.0.0.0/0", except: [IMDS_CIDR, ...blocked] } }],
            ports: [{ protocol: "TCP", port: 443 }],
          },
        ],
      },
    },
    resourceQuota: { apiVersion: "v1", kind: "ResourceQuota", metadata: { name: "drop-quota", namespace }, spec: { hard: quota } },
    limitRange: {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: "drop-defaults", namespace },
      spec: { limits: [{ type: "Container", default: LIMITRANGE_DEFAULT, defaultRequest: LIMITRANGE_DEFAULT_REQUEST }] },
    },
    // (A2b) allow-from-edge-tcp, one per exposed workload — empty unless the tenant exposes TCP.
    edgeTcpPolicies: (opts.edgeTcp?.workloads ?? []).map((w) => edgeTcpAllowPolicy(namespace, opts.edgeTcp!.namespace, w)),
  };
}

// (A2b) The per-workload "allow from edge-tcp" NetworkPolicy: it re-opens ingress from the edge-tcp
// pods (matched by their component label in the platform namespace) to ONLY this workload's pods
// (app.kubernetes.io/name for an app, cnpg.io/cluster for a CNPG database) on ONLY its container port.
// The default-deny (tenantManifests) still blocks everything else; this is the single explicit hole
// the plan's security note describes. Labelled drop.dev/allow=edge-tcp so applyTenant can prune it
// when the workload is later unexposed.
function edgeTcpAllowPolicy(namespace: string, edgeTcpNamespace: string, w: ExposedWorkload): Record<string, unknown> {
  const podSelector =
    w.kind === "database" ? { matchLabels: { "cnpg.io/cluster": w.name } } : { matchLabels: { "app.kubernetes.io/name": w.name } };
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `${w.name}-allow-edge-tcp`,
      namespace,
      labels: { "app.kubernetes.io/managed-by": "drop", "drop.dev/allow": "edge-tcp", "drop.dev/workload": w.name },
    },
    spec: {
      podSelector,
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": edgeTcpNamespace } },
              podSelector: { matchLabels: { "app.kubernetes.io/component": EDGE_TCP_COMPONENT } },
            },
          ],
          ports: [{ protocol: "TCP", port: w.port }],
        },
      ],
    },
  };
}

// Explicit pull policy by ref: a `drop.local/*` image was imported into the node's containerd and
// has NO registry to fall back on, so it MUST be IfNotPresent regardless of tag (incl. :latest).
// Otherwise parse the tag from the LAST ref segment (so a registry-with-port host like
// `reg:5000/app` isn't mistaken for a tagged image): :latest / untagged → Always, else IfNotPresent.
export function imagePullPolicy(image: string): "Always" | "IfNotPresent" {
  if (image.startsWith("drop.local/")) return "IfNotPresent";
  const lastSeg = image.split("/").pop() ?? image;
  const tag = lastSeg.includes(":") ? lastSeg.split(":").pop()! : "latest";
  return tag === "latest" ? "Always" : "IfNotPresent";
}

// The env/secret/DB-binding wiring every process (and the release Job) shares. Computed once from
// the AppConfig, then handed to each container so all processes carry identical env — SEC-5.
interface AppBinding {
  envFrom: Record<string, unknown>[]; // <db>-app (per app.uses) → <name>-env config → <name>-secret (optional, last → wins)
  env: Record<string, unknown>[]; // PGSSLMODE/PGSSLROOTCERT for bound databases; empty otherwise
  volumes: Record<string, unknown>[]; // read-only CA volumes for bound databases
  volumeMounts: Record<string, unknown>[];
}

/** Compute the DB-binding + secret wiring shared by all of an app's processes (see app.uses). */
function appBinding(app: AppConfig, name: string): AppBinding {
  const hasEnv = !!app.env && Object.keys(app.env).length > 0;
  // First-class DB binding (app.uses): for each declared database, envFrom its CNPG-generated
  // `<db>-app` Secret (PG* connection incl. password — never copied into the app's own env),
  // mount the cluster CA (`<db>-ca`, ca.crt ONLY — never the CA private key) read-only, and turn
  // on full TLS verification. The `<db>-app`/`<db>-ca` Secrets are namespace-scoped, so this only
  // resolves when the DB shares the app's namespace — the API enforces same-org before we get here.
  // Only the database uses matter for the CNPG binding (bucket/cache uses inject their env via the
  // write-only secret path at deploy, not here). Keep the full use entries so `via: "pooler"` (I3) can
  // flip PGHOST at the pooler Service.
  const boundUses = app.uses?.filter((u) => u.database) ?? [];
  const boundDbs = boundUses.map((u) => u.database!);
  return {
    // Sources, in order:
    //  - <db>-app: each bound database's CNPG creds Secret (app.uses) — the base layer.
    //  - <name>-env: non-secret config from drop.yaml app.env (only when present).
    //  - <name>-secret: write-only app secrets managed out-of-band (CLI/dashboard/MCP). Listed LAST
    //    so a secret overrides a same-named config value; optional so a not-yet-created Secret never
    //    blocks startup.
    envFrom: [
      ...boundDbs.map((db) => ({ secretRef: { name: `${db}-app` } })),
      ...(hasEnv ? [{ secretRef: { name: `${name}-env` } }] : []),
      { secretRef: { name: `${name}-secret`, optional: true } },
    ],
    // PG* is a single-connection model, so verify-full is set once and PGSSLROOTCERT points at the
    // FIRST bound db's CA. These are container `env` (not envFrom) so they win over any same-named
    // value the `<db>-app`/config Secrets might carry.
    env: boundDbs.length
      ? [
          { name: "PGSSLMODE", value: "verify-full" },
          { name: "PGSSLROOTCERT", value: `${DB_CA_MOUNT_BASE}/${boundDbs[0]}/ca.crt` },
          // (I3) `via: "pooler"` → route PGHOST at the CNPG Pooler Service (`<db>-pooler-rw`) instead of
          // the primary. Container `env` (not envFrom) so it WINS over any PGHOST the `<db>-app`/config
          // Secrets carry — the exact precedence trick PGSSLMODE uses. PG* is single-connection, so v1
          // applies this to the FIRST bound db when it declares via:pooler.
          ...(boundUses[0]!.via === "pooler" ? [{ name: "PGHOST", value: `${boundDbs[0]}-pooler-rw` }] : []),
        ]
      : [],
    volumes: boundDbs.map((db) => dbCaBinding(db).volume),
    volumeMounts: boundDbs.map((db) => dbCaBinding(db).volumeMount),
  };
}

function resourceLimits(resources?: AppResources): Record<string, string> | undefined {
  if (!resources) return undefined;
  const l = { ...(resources.cpu ? { cpu: resources.cpu } : {}), ...(resources.memory ? { memory: resources.memory } : {}) };
  return Object.keys(l).length ? l : undefined;
}

// string command → shell-form (a full command line); array → exec-form passthrough. Undefined leaves
// the image's own entrypoint (today's default).
function normalizeCommand(command?: string | string[]): string[] | undefined {
  if (command === undefined) return undefined;
  return typeof command === "string" ? ["/bin/sh", "-c", command] : command;
}

// readiness (traffic gate) + liveness (restart wedged pods) probes for the WEB container. With a
// healthcheck: both hit the same HTTP endpoint by default. Without: a plain TCP-socket readiness
// probe on the container port (better than nothing; there's no honest liveness signal without one).
function webProbes(app: AppConfig, containerPort: number): { readinessProbe: Record<string, unknown>; livenessProbe?: Record<string, unknown> } {
  const hc = app.healthcheck;
  // No block, or a keep_warm-ONLY block (no HTTP path — G2b): fall back to the TCP-socket readiness
  // probe. `keep_warm` is a uptime-poller signal, not a k8s probe, so it never emits an httpGet.
  if (!hc || !hc.path) return { readinessProbe: { tcpSocket: { port: containerPort }, periodSeconds: 10, timeoutSeconds: 2 } };
  const httpGet = { path: hc.path, port: containerPort };
  const common = { periodSeconds: hc.interval ?? 10, timeoutSeconds: hc.timeout ?? 2, initialDelaySeconds: hc.grace ?? 15 };
  return { readinessProbe: { httpGet, ...common }, livenessProbe: { httpGet, ...common, failureThreshold: 3 } };
}

// Build one container spec shared by every code path (web pod, worker pod, release Job). The
// security baseline is deliberately minimal — block privilege escalation + default seccomp, but
// DON'T drop caps (most official images chown/setuid at entrypoint and break under `drop: ALL`).
// Stronger isolation is the tenant/PSA/sandbox layer (tenantManifests + optional gVisor).
function buildContainer(opts: {
  name: string;
  image: string;
  binding: AppBinding;
  command?: string | string[];
  containerPort?: number;
  resources?: AppResources;
  probes?: { readinessProbe: Record<string, unknown>; livenessProbe?: Record<string, unknown> };
}): Record<string, unknown> {
  const limits = resourceLimits(opts.resources);
  const command = normalizeCommand(opts.command);
  return {
    name: opts.name,
    image: opts.image,
    imagePullPolicy: imagePullPolicy(opts.image), // explicit, not k8s' tag-based default (see imagePullPolicy)
    ...(command ? { command } : {}),
    ...(opts.containerPort != null ? { ports: [{ containerPort: opts.containerPort }] } : {}),
    envFrom: opts.binding.envFrom, // env lives in Secrets, not plaintext in the pod spec (SEC-5)
    ...(opts.binding.env.length ? { env: opts.binding.env } : {}),
    ...(limits ? { resources: { limits, requests: limits } } : {}),
    ...(opts.binding.volumeMounts.length ? { volumeMounts: opts.binding.volumeMounts } : {}),
    ...(opts.probes?.readinessProbe ? { readinessProbe: opts.probes.readinessProbe } : {}),
    ...(opts.probes?.livenessProbe ? { livenessProbe: opts.probes.livenessProbe } : {}),
    securityContext: { allowPrivilegeEscalation: false, seccompProfile: { type: "RuntimeDefault" } },
  };
}

// Pod spec shared by a Deployment/Job template: sandbox RuntimeClass + pull secret + one container
// + the DB-CA volumes.
function podSpec(ctx: ManifestContext, container: Record<string, unknown>, binding: AppBinding, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(ctx.sandbox ? { runtimeClassName: "gvisor" } : {}),
    // Pull secret for a private registry image (registry backend). Local containerd-imported images
    // need none (already on the node); ECR-via-IRSA needs none either.
    ...(ctx.imagePullSecret ? { imagePullSecrets: [{ name: ctx.imagePullSecret }] } : {}),
    containers: [container],
    ...(binding.volumes.length ? { volumes: binding.volumes } : {}), // CA volumes for bound databases (app.uses)
    ...extra,
  };
}

// Pod-template metadata for a Deployment: the selector labels, plus (H1) the `drop.dev/version`
// annotation when the caller supplied one — present on every process's template so ANY deploy or
// rollback rolls pods, even when the image tag is byte-for-byte unchanged (see ManifestContext.versionId).
function podTemplateMeta(labels: Record<string, string>, ctx: ManifestContext): Record<string, unknown> {
  return { labels, ...(ctx.versionId ? { annotations: { "drop.dev/version": ctx.versionId } } : {}) };
}

// (H2) A scheduled app's ENTIRE manifest set: a CronJob (no Deployment/Service/HTTPScaledObject —
// there is no listener to route to) + the shared `<name>-env` config Secret (unchanged from the
// web/worker shape). `drop.dev/kind: cron` (alongside the usual `drop.dev/workload`) lets teardown /
// stop-start select this object distinctly from a Deployment. The container is built the SAME way as
// the web container (image, uses-bindings + write-only secret envFrom, CA volumes, resources,
// securityContext, the drop.dev/version annotation) — just with `app.command` and no probes/port
// (assertProcesses already refused a `healthcheck` alongside `schedule`).
function cronAppManifests(app: AppConfig, ctx: ManifestContext, binding: AppBinding, hasEnv: boolean): AppManifests {
  const labels = { "app.kubernetes.io/name": ctx.name, "app.kubernetes.io/managed-by": "drop", "drop.dev/workload": ctx.name, "drop.dev/kind": "cron" };
  const container = buildContainer({ name: ctx.name, image: app.image, binding, command: app.command, resources: app.resources });
  const out: AppManifests = {
    cronJob: {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels },
      spec: {
        schedule: app.schedule,
        concurrencyPolicy: "Forbid", // never let two runs of the same job overlap
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        startingDeadlineSeconds: 120, // a fire missed by more than this (e.g. control-plane hiccup) is just skipped, not queued
        jobTemplate: {
          metadata: { labels },
          spec: {
            backoffLimit: 1, // one retry — a scheduled job that keeps failing shouldn't hammer forever
            template: { metadata: podTemplateMeta(labels, ctx), spec: podSpec(ctx, container, binding, { restartPolicy: "Never" }) },
          },
        },
      },
    },
  };
  if (hasEnv && !ctx.sharedSecretName) {
    const envLabels = { "app.kubernetes.io/name": ctx.name, "app.kubernetes.io/managed-by": "drop", "drop.dev/workload": ctx.name };
    out.secret = { apiVersion: "v1", kind: "Secret", metadata: { name: `${ctx.name}-env`, namespace: ctx.namespace, labels: envLabels }, stringData: app.env };
  }
  return out;
}

export function appManifests(app: AppConfig, ctx: ManifestContext): AppManifests {
  if (!ctx.tcpExposed) assertHttpOnly(app); // v1 guard: exactly one HTTP service (retired for TCP-exposed apps, A2b)
  assertProcesses(app); // at most one web process; schedule's exclusivity with processes/services/healthcheck (H2)
  // (E2) A preview envFroms the PARENT's `<parent>-env`/`<parent>-secret` (ctx.sharedSecretName) — never
  // its own — so it reuses the parent's config + write-only secrets read-only. A normal deploy keys them
  // on its own workload name.
  const binding = appBinding(app, ctx.sharedSecretName ?? ctx.name);
  // (H3) app→app URLs: plain, non-secret container env resolved by the reconciler. Appended to the
  // shared binding so EVERY process (web + workers, and a cron app) carries identical env (SEC-5).
  // Container `env` (last) so it wins over any same-named config/secret value, same as PGSSLMODE.
  if (ctx.appUrlEnv?.length) binding.env = [...binding.env, ...ctx.appUrlEnv];
  const hasEnv = !!app.env && Object.keys(app.env).length > 0;

  // (H2) `schedule` replaces the ENTIRE web/worker surface with a single CronJob — no Deployment,
  // Service, or HTTPScaledObject is ever emitted for a scheduled app (assertProcesses already refused
  // schedule alongside processes/an explicit services/healthcheck, so there's no web process to build
  // anyway). `scale` is deliberately ignored here: a CronJob has no HPA/KEDA target to size.
  if (app.schedule) return cronAppManifests(app, ctx, binding, hasEnv);

  const containerPort = app.services[0]!.internalPort;
  const processes = expandProcesses(app, ctx.name);

  const out: AppManifests = {};

  // --- web process: today's Deployment + Service + HTTPScaledObject + interceptor NetworkPolicy ---
  const web = processes.find((p) => p.web);
  if (web) {
    // The web labels/selector are UNCHANGED from before processes existed (no new selector labels),
    // so redeploying an existing app never trips the immutable-selector guard.
    const labels = { "app.kubernetes.io/name": ctx.name, "app.kubernetes.io/managed-by": "drop", "drop.dev/workload": ctx.name };
    // (I5) The Deployment's OWN metadata + its pod-template labels may carry MORE than the selector
    // (k8s only requires the selector to be a SUBSET of the template's labels) — so the "stateful"
    // marker (teardown sweeps + the console/CLI badge) is added here, never folded into `labels` itself,
    // which keeps the immutable `spec.selector` unchanged even if an app toggles `stateful` on later.
    const podLabels = app.stateful ? { ...labels, "drop.dev/stateful": "true" } : labels;
    const pvcName = `${ctx.name}-data`;
    // (I5) One RWO volume mounted at `stateful.mount`, appended to a WEB-ONLY copy of the shared
    // binding (never mutating `binding` itself — irrelevant in practice since assertProcesses already
    // refuses `processes` alongside `stateful`, i.e. a stateful app has no worker to leak it to, but
    // this keeps the function correct regardless of that invariant holding elsewhere).
    const webBinding: AppBinding = app.stateful
      ? {
          ...binding,
          volumes: [...binding.volumes, { name: "data", persistentVolumeClaim: { claimName: pvcName } }],
          volumeMounts: [...binding.volumeMounts, { name: "data", mountPath: app.stateful.mount }],
        }
      : binding;
    const container = buildContainer({
      name: ctx.name,
      image: app.image,
      binding: webBinding,
      command: web.command,
      containerPort,
      resources: web.resources,
      probes: webProbes(app, containerPort),
    });
    out.deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels: podLabels },
      spec: {
        selector: { matchLabels: labels },
        // (I5) A stateful app has NO HTTPScaledObject to own the replica count (see below), so
        // `replicas` is explicit here — unlike the normal web Deployment, which omits it deliberately —
        // and `strategy: Recreate` guarantees the OLD pod fully releases the RWO PVC attachment before
        // the new one starts (a rolling update would try to attach it from two pods at once and fail).
        ...(app.stateful ? { replicas: web.scale.min, strategy: { type: "Recreate" } } : {}),
        template: { metadata: podTemplateMeta(podLabels, ctx), spec: podSpec(ctx, container, webBinding) },
      },
    };
    out.service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels },
      spec: { selector: labels, ports: [{ name: "http", port: SERVICE_PORT, targetPort: containerPort }] },
    };
    // (I5) `stateful` forces scale {min:1,max:1} (assertProcesses) — an always-on app that can never
    // scale to zero, so there is nothing for KEDA to own here: NO HTTPScaledObject is emitted at all.
    if (!app.stateful) {
      out.httpScaledObject = {
        apiVersion: "http.keda.sh/v1alpha1",
        kind: "HTTPScaledObject",
        metadata: { name: ctx.name, namespace: ctx.namespace, labels },
        spec: {
          hosts: [ctx.host],
          scaleTargetRef: { name: ctx.name, kind: "Deployment", apiVersion: "apps/v1", service: ctx.name, port: SERVICE_PORT },
          replicas: { min: web.scale.min, max: web.scale.max },
          scaledownPeriod: 300,
        },
      };
    }
    // (I5) The PVC itself: RWO, sized to `stateful.volume`, no `storageClassName` (the namespace's
    // default StorageClass applies). Labeled like the Deployment (incl. the stateful marker) so
    // teardown + the console/CLI badge can find it without a stored-config lookup.
    if (app.stateful) {
      out.pvc = {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: pvcName, namespace: ctx.namespace, labels: podLabels },
        spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: app.stateful.volume } } },
      };
    }
    // Allow the KEDA interceptor (in the keda namespace) to reach the web pods on the CONTAINER
    // port. The keda namespace is matched by its immutable, control-plane-injected label. (I5) Kept
    // unconditionally even for a stateful app (which has no HTTPScaledObject to route through it) —
    // it's inert without one, and leaving it out is not a meaningfully smaller attack surface (the
    // default-deny NetworkPolicy already blocks everything else), so there's no reason to special-case it.
    out.ingressPolicy = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: `${ctx.name}-allow-interceptor`, namespace: ctx.namespace, labels },
      spec: {
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": KEDA_NAMESPACE } } }],
            ports: [{ protocol: "TCP", port: containerPort }],
          },
        ],
      },
    };
  }

  // --- worker processes: a plain Deployment each (no Service, no HTTPScaledObject) ---
  // Static replicas = scale.min (min≥1 for a plain worker; may be 0 for a scale_on worker — see
  // expandProcesses). (L1b) A worker with `scale_on` ALSO gets a KEDA ScaledObject below, pointed at
  // the FIRST `{cache}` binding in `uses` — v1 binds a single Valkey per app (mirrors the DB/bucket
  // binding convention: "first" is deterministic and unambiguous for the common one-cache case; a
  // multi-cache app would need a per-process `cache:` key to disambiguate, out of scope here).
  // assertProcesses (called above) already guarantees a bound cache exists whenever any scale_on is
  // present, so `cacheUse` is non-null by the time a worker with scaleOn reaches the loop below.
  const cacheUse = app.uses?.find((u) => u.cache);
  const workers: WorkerManifests[] = [];
  for (const w of processes.filter((p) => !p.web)) {
    const labels = {
      "app.kubernetes.io/name": w.name,
      "app.kubernetes.io/managed-by": "drop",
      "drop.dev/workload": ctx.name, // groups every process under the app (teardown + `drop ps`)
      "drop.dev/process": w.process, // distinguishes workers from the web Deployment
    };
    const container = buildContainer({ name: w.name, image: app.image, binding, command: w.command, resources: w.resources });
    const wm: WorkerManifests = {
      name: w.name,
      process: w.process,
      deployment: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: w.name, namespace: ctx.namespace, labels },
        // `replicas: w.scale.min` is the INITIAL value even for a scale_on worker — KEDA's ScaledObject
        // takes over the count once its controller reconciles (same "first apply, then KEDA owns it"
        // pattern as the web Deployment, just kept explicit here: an entirely-absent `replicas` field
        // on a brand-new Deployment defaults to 1, which would be wrong for a min:0 scale_on worker).
        spec: { replicas: w.scale.min, selector: { matchLabels: labels }, template: { metadata: podTemplateMeta(labels, ctx), spec: podSpec(ctx, container, binding) } },
      },
    };
    if (w.scaleOn && cacheUse?.cache) {
      // KEDA's redis-lists scaler wants `address` (host:port) and `password` supplied separately.
      // `address` is plaintext trigger metadata (not a secret) — a ClusterIP host:port isn't sensitive,
      // same reasoning as the DB binding's PGHOST. The password stays out of the manifest entirely: the
      // TriggerAuthentication below references the cache's OWN `<cache>-cache` Secret (see valkey.ts) —
      // the same Secret the app's own REDIS_URL binding reads back from (src/api/server.ts) — so no new
      // secret is minted here and the write-only posture holds (this file never carries secret VALUES).
      const address = `${cacheHost(cacheUse.cache, ctx.namespace)}:6379`;
      wm.triggerAuth = {
        apiVersion: "keda.sh/v1alpha1",
        kind: "TriggerAuthentication",
        metadata: { name: w.name, namespace: ctx.namespace, labels },
        spec: { secretTargetRef: [{ parameter: "password", name: `${cacheUse.cache}-cache`, key: "password" }] },
      };
      wm.scaledObject = {
        apiVersion: "keda.sh/v1alpha1",
        kind: "ScaledObject",
        metadata: { name: w.name, namespace: ctx.namespace, labels },
        spec: {
          scaleTargetRef: { name: w.name, kind: "Deployment" },
          minReplicaCount: w.scale.min, // (L1b) may be 0 — the queue is the wake source
          maxReplicaCount: w.scale.max,
          triggers: [
            {
              type: "redis",
              metadata: { address, listName: w.scaleOn.queue, listLength: String(w.scaleOn.target) },
              authenticationRef: { name: w.name },
            },
          ],
        },
      };
    }
    workers.push(wm);
  }
  if (workers.length) out.workers = workers;

  // Shared config Secret (`<name>-env`) — one for the whole app, referenced by every process. (E2) A
  // preview (ctx.sharedSecretName) reads the PARENT's `<parent>-env` instead, so it emits none of its own.
  if (hasEnv && !ctx.sharedSecretName) {
    const labels = { "app.kubernetes.io/name": ctx.name, "app.kubernetes.io/managed-by": "drop", "drop.dev/workload": ctx.name };
    out.secret = { apiVersion: "v1", kind: "Secret", metadata: { name: `${ctx.name}-env`, namespace: ctx.namespace, labels }, stringData: app.env };
  }
  return out;
}

// ============================ (A2b) edge-tcp router objects =================================
// The L4 router runs as its own small Deployment + Service in the PLATFORM namespace (alongside
// api/edge), NOT in a tenant namespace — it needs cluster Service DNS + its own NetworkPolicy
// identity to reach every tenant's exposed workloads. This is the canonical object shape; the Helm
// chart mirrors it (with a Secret-backed DROP_DATABASE_URL + the NLB annotations in prod values) and
// the API patches ONLY the Service's port list as ports are allocated/released.

export type EdgeTcpSharedProtocol = "postgres" | "tls-sni";

export interface EdgeTcpContext {
  name: string; // object name, e.g. "drop-edge-tcp"
  namespace: string; // the platform namespace (where api/edge run)
  image: string;
  sharedPorts: { port: number; protocol: EdgeTcpSharedProtocol }[]; // well-known SNI/PG ports (always on the Service)
  portRange: { from: number; to: number }; // the FULL dynamic pool the router binds at boot (so any allocated port is already listening)
  activeDynamicPorts?: number[]; // dynamic ports with a LIVE expose → get a Service/NLB listener (quota-frugal: unused ports get none)
  serviceType?: "LoadBalancer" | "ClusterIP"; // LoadBalancer (NLB) in prod, ClusterIP locally
  annotations?: Record<string, string>; // Service annotations (the NLB `internal` / `nlb-target-type: ip` set in prod)
  replicas?: number;
  resources?: AppResources;
  env?: Record<string, unknown>[]; // extra container env (e.g. DROP_DATABASE_URL from a Secret ref)
  command?: string[]; // default ["node", "dist/edge-tcp.js"]
}

export interface EdgeTcpManifests {
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
}

/** A stable, DNS-safe port name from a port number + role prefix (k8s Service port names are ≤15 chars). */
function tcpPortName(prefix: string, port: number): string {
  return `${prefix}-${port}`;
}

/** The edge-tcp Deployment + Service. The Deployment binds the WHOLE dynamic range (so a freshly
 *  allocated port is already listened on — no router restart on expose); the Service publishes only
 *  the shared ports + the currently-active dynamic ports (so the NLB burns a listener only per live
 *  port). Pure: the API/Helm decide the image, service type + annotations, and DB env. */
export function edgeTcpManifests(ctx: EdgeTcpContext): EdgeTcpManifests {
  const labels = {
    "app.kubernetes.io/name": ctx.name,
    "app.kubernetes.io/managed-by": "drop",
    "app.kubernetes.io/component": EDGE_TCP_COMPONENT,
  };
  const active = [...new Set(ctx.activeDynamicPorts ?? [])].sort((a, b) => a - b);
  const servicePorts = [
    ...ctx.sharedPorts.map((s) => ({ name: tcpPortName(s.protocol === "postgres" ? "pg" : "sni", s.port), port: s.port, targetPort: s.port, protocol: "TCP" })),
    ...active.map((p) => ({ name: tcpPortName("dyn", p), port: p, targetPort: p, protocol: "TCP" })),
  ];
  const containerPorts = servicePorts.map((p) => ({ containerPort: p.port, protocol: "TCP" }));
  const sharedSpec = ctx.sharedPorts.map((s) => `${s.port}:${s.protocol}`).join(",");
  const limits = resourceLimits(ctx.resources);
  const container = {
    name: EDGE_TCP_COMPONENT,
    image: ctx.image,
    imagePullPolicy: imagePullPolicy(ctx.image),
    command: ctx.command ?? ["node", "dist/edge-tcp.js"],
    ports: containerPorts,
    env: [
      { name: "DROP_TCP_SHARED_PORTS", value: sharedSpec },
      { name: "DROP_TCP_DYNAMIC_RANGE", value: `${ctx.portRange.from}-${ctx.portRange.to}` },
      ...(ctx.env ?? []),
    ],
    ...(limits ? { resources: { limits, requests: limits } } : {}),
    securityContext: { allowPrivilegeEscalation: false, seccompProfile: { type: "RuntimeDefault" } },
  };
  return {
    deployment: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels },
      spec: {
        replicas: ctx.replicas ?? 1,
        selector: { matchLabels: labels },
        template: { metadata: { labels }, spec: { containers: [container] } },
      },
    },
    service: {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels, ...(ctx.annotations ? { annotations: ctx.annotations } : {}) },
      spec: { type: ctx.serviceType ?? "ClusterIP", selector: labels, ports: servicePorts },
    },
  };
}

export interface ReleaseJobContext extends ManifestContext {
  versionId: string; // the deploy's version id → a deterministic Job name `<name>-release-<versionId>`
}

// The release Job (run BEFORE the new Deployment is applied): same image/env/bindings/secrets as the
// app container, `backoffLimit: 0` / `restartPolicy: Never` (one shot — no silent retries of a
// migration), a deterministic name for log retrieval, and labels so teardown + `drop logs --release`
// find it. Its command is the release command in shell form. The API waits for it and halts the
// deploy on failure (old version keeps serving). The `host` in ctx is unused (Jobs aren't routed).
export function releaseJobManifest(app: AppConfig, ctx: ReleaseJobContext): Record<string, unknown> {
  const jobName = `${ctx.name}-release-${ctx.versionId}`;
  const binding = appBinding(app, ctx.name);
  const labels = { "app.kubernetes.io/managed-by": "drop", "drop.dev/workload": ctx.name, "drop.dev/job": "release" };
  const container = buildContainer({ name: "release", image: app.image, binding, command: app.release!.command, resources: app.resources });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName, namespace: ctx.namespace, labels },
    spec: {
      backoffLimit: 0, // one shot: a failed migration is terminal, never silently retried
      activeDeadlineSeconds: (app.release!.timeout ?? 300) + 30, // server also bounds the wait by the timeout
      ttlSecondsAfterFinished: 3600, // keep ~1h for log retrieval; also GC'd on next deploy + app delete
      template: {
        // app.kubernetes.io/name=<job> lets getWorkloadLogs/getReleaseLogs surface this Job's pod logs.
        metadata: { labels: { ...labels, "app.kubernetes.io/name": jobName } },
        spec: podSpec(ctx, container, binding, { restartPolicy: "Never" }),
      },
    },
  };
}
