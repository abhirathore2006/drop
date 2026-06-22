// Pure translator: DatabaseConfig (+ tenant/backup context) → the CloudNativePG objects
// that run a managed Postgres. No cluster access here — a deterministic mapping the API
// applies via a KubeClient (mirrors manifests.ts for apps).
//
// FUTURE-PROOF: backups go through the **Barman Cloud Plugin** (an ObjectStore CR +
// Cluster.spec.plugins), NOT the in-tree spec.backup.barmanObjectStore which is
// deprecated as of CNPG v1.26. Shapes verified against the live CRDs (plugin v0.13.0,
// operator 1.29.x): ObjectStore is barmancloud.cnpg.io/v1; the plugin name string is
// "barman-cloud.cloudnative-pg.io"; ScheduledBackup needs method:plugin (the default is
// the deprecated path); hibernation is the cnpg.io/hibernation annotation (no spec field).
import type { DatabaseConfig } from "../db-config.ts";

const PLUGIN_NAME = "barman-cloud.cloudnative-pg.io";
const CNPG_NAMESPACE = "cnpg-system"; // where the operator + plugin Deployment run
const DEFAULT_SCHEDULE = "0 0 2 * * *"; // 6-FIELD cron (seconds first): daily 02:00:00
const DEFAULT_RESOURCES = {
  requests: { memory: "256Mi", cpu: "100m" },
  limits: { memory: "512Mi", cpu: "500m" },
};

const DEFAULT_API_CIDRS = ["10.0.0.0/8"]; // local k3s: API/service CIDR is in 10/8 (matches tenantManifests' default)

export interface DatabaseManifestContext {
  name: string; // claimed workload name (DNS-safe) — the CNPG Cluster name
  namespace: string; // tenant namespace
  destinationPath: string; // s3://<bucket>/<path> for backups/WAL
  s3?: { endpointURL?: string; accessKeyId?: string; secretAccessKey?: string }; // local (Floci/MinIO); omit for prod IRSA
  iamRoleArn?: string; // prod IRSA: bound on the instance ServiceAccount template
  schedule?: string; // 6-field cron; default daily 02:00
  resources?: { requests?: { memory?: string; cpu?: string }; limits?: { memory?: string; cpu?: string } };
  // In-cluster/control-plane CIDRs (same value threaded into tenantManifests). The DB
  // egress re-allows ONLY these on 443/6443 (the API server the tenant policy blocks).
  apiServerCidrs?: string[];
}

export interface DatabaseManifests {
  objectStore: Record<string, unknown>; // barmancloud.cnpg.io/v1 ObjectStore (backup target)
  cluster: Record<string, unknown>; // postgresql.cnpg.io/v1 Cluster (wired to the plugin)
  scheduledBackup: Record<string, unknown>; // postgresql.cnpg.io/v1 ScheduledBackup (method: plugin)
  networkPolicy: Record<string, unknown>; // cnpg-system ingress + API/object-store egress for DB pods
  secret?: Record<string, unknown>; // S3 creds (local only; omitted under IRSA)
}

/** Build the CNPG objects for one managed database in a tenant namespace. */
export function databaseManifests(db: DatabaseConfig, ctx: DatabaseManifestContext): DatabaseManifests {
  const labels = {
    "app.kubernetes.io/name": ctx.name,
    "app.kubernetes.io/managed-by": "drop",
    "drop.dev/workload": ctx.name,
    "drop.dev/hibernation": db.hibernation, // the C5 idle CronJob targets drop.dev/hibernation=scheduled
  };
  const storeName = `${ctx.name}-store`;
  const credsSecretName = `${ctx.name}-backup-creds`;
  const useStaticCreds = !!(ctx.s3?.accessKeyId && ctx.s3?.secretAccessKey);

  // S3 credentials: static Secret locally (Floci/MinIO), IRSA in prod (the instance SA
  // carries the IAM role and the SDK resolves creds from the environment). The API fails
  // closed in prod when no IAM role is set, so the static-creds branch is LOCAL-ONLY — the
  // local key must be a throwaway, ideally scoped to the `databases/<ns>/<name>` prefix.
  const s3Credentials = useStaticCreds
    ? {
        accessKeyId: { name: credsSecretName, key: "ACCESS_KEY_ID" },
        secretAccessKey: { name: credsSecretName, key: "ACCESS_SECRET_KEY" },
      }
    : { inheritFromIAMRole: true };

  const objectStore = {
    apiVersion: "barmancloud.cnpg.io/v1",
    kind: "ObjectStore",
    metadata: { name: storeName, namespace: ctx.namespace, labels },
    spec: {
      configuration: {
        destinationPath: ctx.destinationPath,
        ...(ctx.s3?.endpointURL ? { endpointURL: ctx.s3.endpointURL } : {}), // local only; omit → real AWS S3
        s3Credentials,
        wal: { compression: "gzip" },
        data: { compression: "gzip" },
      },
    },
  };

  const resources = ctx.resources ?? DEFAULT_RESOURCES;
  const cluster = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name: ctx.name, namespace: ctx.namespace, labels },
    spec: {
      instances: 1,
      // WAL archiving + backups via the Barman Cloud Plugin (NOT spec.backup.barmanObjectStore).
      plugins: [{ name: PLUGIN_NAME, isWALArchiver: true, parameters: { barmanObjectName: storeName } }],
      storage: { size: db.storage },
      resources,
      // prod IRSA: the instance pods run under a ServiceAccount annotated with the IAM role.
      ...(ctx.iamRoleArn ? { serviceAccountTemplate: { metadata: { annotations: { "eks.amazonaws.com/role-arn": ctx.iamRoleArn } } } } : {}),
    },
  };

  const scheduledBackup = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "ScheduledBackup",
    metadata: { name: `${ctx.name}-daily`, namespace: ctx.namespace, labels },
    spec: {
      schedule: ctx.schedule ?? DEFAULT_SCHEDULE,
      backupOwnerReference: "self",
      cluster: { name: ctx.name },
      method: "plugin", // MUST be explicit — the default is the deprecated barmanObjectStore
      pluginConfiguration: { name: PLUGIN_NAME, parameters: { barmanObjectName: storeName } },
    },
  };

  // CNPG instance pods are platform-managed, but a compromised Postgres/barman image must
  // NOT get blanket egress. We grant only what the operator needs, each scoped to a
  // destination (NOT `to`-less rules, which mean "everywhere" and — being additive with the
  // tenant policy — would re-open 0.0.0.0/0 on 443 and cross-tenant 5432):
  //  - intra-namespace (replicas + the app),
  //  - DNS,
  //  - the cnpg-system operator/plugin namespace (CNPG-I gRPC),
  //  - the in-cluster API server on 443/6443, scoped to the cluster/control-plane CIDRs
  //    that the tenant 443-allowlist EXCLUDES (the instance manager needs it).
  // Public S3 (443 to the internet) is already granted by the tenant policy (additive), so
  // it is intentionally NOT repeated here. INGRESS stays tight: intra-ns apps (tenant policy)
  // + the cnpg-system operator (here) — no public ingress.
  const apiCidrs = ctx.apiServerCidrs && ctx.apiServerCidrs.length > 0 ? ctx.apiServerCidrs : DEFAULT_API_CIDRS;
  const networkPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: `${ctx.name}-db`, namespace: ctx.namespace, labels },
    spec: {
      podSelector: { matchLabels: { "cnpg.io/cluster": ctx.name } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": CNPG_NAMESPACE } } }] }, // operator manages instances
      ],
      egress: [
        { to: [{ podSelector: {} }] }, // intra-namespace (replicas, the app)
        { to: [{ namespaceSelector: {} }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }, // DNS
        { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": CNPG_NAMESPACE } } }] }, // CNPG operator/plugin (CNPG-I)
        // in-cluster API server only — scoped to the control-plane/cluster CIDRs, never 0.0.0.0/0.
        { to: apiCidrs.map((cidr) => ({ ipBlock: { cidr } })), ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 6443 }] },
      ],
    },
  };

  const out: DatabaseManifests = { objectStore, cluster, scheduledBackup, networkPolicy };
  if (useStaticCreds) {
    out.secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: credsSecretName, namespace: ctx.namespace, labels },
      stringData: { ACCESS_KEY_ID: ctx.s3!.accessKeyId, ACCESS_SECRET_KEY: ctx.s3!.secretAccessKey },
    };
  }
  return out;
}
