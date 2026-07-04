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
import { extensionSqlName, type DatabaseConfig } from "../db-config.ts";

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
  // LOCAL only: when the object store is an in-cluster/non-443 endpoint (e.g. Floci/MinIO
  // on :4566), allow the DB pod to egress to it. Prod S3 is public 443 — already allowed by
  // the tenant policy — so this is omitted in prod.
  objectStoreEgress?: { cidr: string; port: number };
  // The `app` user's password, set ONLY at create. Present → emit the platform-owned creds
  // Secret + wire bootstrap.initdb.secret at it (so CNPG does NOT auto-generate/own the
  // `<name>-app` Secret — we own it, which lets set-password rotate it later). Absent on a
  // re-apply (update) so the password is never silently rotated; bootstrap is immutable then.
  appPassword?: string;
}

// Fallback operand image for the password-rotation Job when the live Cluster status hasn't
// reported its image yet. The Job only needs psql; any recent CNPG operand image carries it.
export const DEFAULT_OPERAND_IMAGE = "ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie";

export interface DatabaseManifests {
  objectStore: Record<string, unknown>; // barmancloud.cnpg.io/v1 ObjectStore (backup target)
  cluster: Record<string, unknown>; // postgresql.cnpg.io/v1 Cluster (wired to the plugin)
  scheduledBackup: Record<string, unknown>; // postgresql.cnpg.io/v1 ScheduledBackup (method: plugin)
  networkPolicy: Record<string, unknown>; // cnpg-system ingress + API/object-store egress for DB pods
  secret?: Record<string, unknown>; // S3 creds (local only; omitted under IRSA)
  appSecret?: Record<string, unknown>; // basic-auth `app` creds — set only at create (when ctx.appPassword is present)
  // (L2 database branching / FM item 9 recovery) present ONLY on a `recoveryDatabaseManifests` result:
  // the SOURCE database's Barman ObjectStore (+ its local S3 creds Secret) that `bootstrap.recovery`
  // reads to clone the source's backup objects. A normal (empty-init) database omits both. applyDatabase
  // applies them BEFORE the Cluster (its externalClusters ref the ObjectStore); deleteDatabase reaps them
  // by their fixed `<name>-recovery-src[-creds]` names (idempotent, 404-safe for a non-branch db).
  sourceObjectStore?: Record<string, unknown>; // barmancloud.cnpg.io/v1 ObjectStore — the READ-ONLY recovery source
  sourceSecret?: Record<string, unknown>; // S3 creds for reading the source backup (local only; IRSA omits)
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
      // The `app` user/database are bootstrapped from a PLATFORM-owned Secret (not CNPG's
      // auto-generated one) so set-password can later rotate the Secret without fighting the
      // operator over ownership. `bootstrap.initdb` is immutable post-create — re-applying with
      // the same secret ref is a no-op, so this is safe on update. NOT managed.roles: that path
      // does not reliably re-apply a changed password for the bootstrap app user (verified).
      bootstrap: {
        initdb: {
          database: "app",
          owner: "app",
          secret: { name: `${ctx.name}-app` },
          // (I3) Extensions are created at BOOTSTRAP only — postInitApplicationSQL runs once against the
          // `app` database on first init (pgvector's SQL name is `vector`; none of the allowlisted set
          // needs shared_preload_libraries). bootstrap.initdb is immutable post-create, so adding an
          // extension to an EXISTING db can't ride this path — the API returns a 409 (v1 limitation).
          ...(db.extensions?.length ? { postInitApplicationSQL: db.extensions.map((e) => `CREATE EXTENSION IF NOT EXISTS ${extensionSqlName(e)};`) } : {}),
        },
      },
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
        // LOCAL only: a non-443 object store (Floci/MinIO) on a specific CIDR. Verified:
        // CNPG WAL-archive + base backup reach Floci with this rule. Omitted in prod (S3=443).
        ...(ctx.objectStoreEgress
          ? [{ to: [{ ipBlock: { cidr: ctx.objectStoreEgress.cidr } }], ports: [{ protocol: "TCP", port: ctx.objectStoreEgress.port }] }]
          : []),
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
  // The `app` creds Secret is emitted only at create (ctx.appPassword present). It is the
  // connection Secret the tenant's apps read, and the source for bootstrap.initdb. basic-auth
  // type (username+password) is what CNPG's initdb.secret expects.
  if (ctx.appPassword) {
    out.appSecret = {
      apiVersion: "v1",
      kind: "Secret",
      type: "kubernetes.io/basic-auth",
      metadata: { name: `${ctx.name}-app`, namespace: ctx.namespace, labels },
      stringData: { username: "app", password: ctx.appPassword },
    };
  }
  return out;
}

/** A database RECOVERY source: another database's Barman object-store backup (its S3 path + creds) plus
 *  an optional point-in-time. `recoveryDatabaseManifests` bootstraps a fresh Cluster FROM this — reading
 *  the backup OBJECTS only, never the source's live volume/primary. Shared machinery: L2 preview
 *  branching AND FM item 9 (restore-to-new-db) both build the same shape from this one export. */
export interface RecoverySource {
  clusterName: string; // the SOURCE CNPG Cluster name (== its Barman `serverName` under destinationPath)
  destinationPath: string; // s3://<bucket>/databases/<ns>/<sourceDb> — the source's Barman backup ROOT (read-only)
  s3?: { endpointURL?: string; accessKeyId?: string; secretAccessKey?: string }; // local static creds to READ the source backup; omit under IRSA
  iamRoleArn?: string; // prod IRSA: read the source backup via the recovered instance's SA role (inheritFromIAMRole)
  targetTime?: string; // optional point-in-time (ISO) → bootstrap.recovery.recoveryTarget.targetTime; omit → latest base backup
}

/** A `recoveryDatabaseManifests` result: a normal DatabaseManifests set whose Cluster is bootstrapped
 *  via `bootstrap.recovery`, PLUS the source ObjectStore (always) and its creds Secret (local only). */
export interface RecoveryDatabaseManifests extends DatabaseManifests {
  sourceObjectStore: Record<string, unknown>; // narrowed: always present on a recovery result
}

/** Build the CNPG objects for a database RECOVERED (branched) from another database's Barman
 *  object-store backup — the shared `bootstrap.recovery` machinery (L2 preview branching builds it here;
 *  FM item 9 consumes the SAME export). The recovered Cluster:
 *   - bootstraps via `bootstrap.recovery` from the SOURCE's backup OBJECTS (an ObjectStore CR + an
 *     `externalClusters` entry that references it) — it NEVER touches the source's live volume or its
 *     primary (no `pg_basebackup`, no `connectionParameters`): recovery only READS the backup objects,
 *     so the source is completely untouched;
 *   - is point-in-time to `source.targetTime` when given (`recoveryTarget.targetTime`), else the latest
 *     base backup + WAL;
 *   - gets its OWN generated `app` password (via `ctx.appPassword`) — `bootstrap.recovery.secret` re-sets
 *     the recovered `app` owner's password to the branch's own Secret, so the branch is credential-
 *     ISOLATED from the source even though the DATA is a copy;
 *   - archives its OWN WAL + backups to its OWN ObjectStore (`<name>-store`, from the base manifests),
 *     at its OWN destinationPath — a branch never writes into the source's backup prefix.
 *  The NetworkPolicy is identical to a normal db: the source backup lives in the SAME bucket/endpoint, so
 *  the egress the base manifests already grant (to that object store) also covers reading the source. */
export function recoveryDatabaseManifests(db: DatabaseConfig, ctx: DatabaseManifestContext, opts: { source: RecoverySource }): RecoveryDatabaseManifests {
  const { source } = opts;
  // Reuse the standard manifests for the recovered cluster's OWN ObjectStore/ScheduledBackup/NetworkPolicy/
  // app Secret/S3 creds Secret — we only SWAP the Cluster's bootstrap (initdb → recovery) and add the
  // source as an external cluster. (ctx.appPassword present ⇒ appSecret emitted = the branch's own creds.)
  const base = databaseManifests(db, ctx);
  const labels = (base.cluster as { metadata: { labels: Record<string, string> } }).metadata.labels;

  // The SOURCE's Barman ObjectStore — a DISTINCT CR (its own `<name>-recovery-src` name) so it never
  // collides with THIS cluster's own `<name>-store`. Points at the source db's backup root; recovery
  // reads these objects. Its own creds (static local, or IRSA) mirror the base store's credential model.
  const srcStoreName = `${ctx.name}-recovery-src`;
  const srcCredsSecretName = `${srcStoreName}-creds`;
  const useSrcStaticCreds = !!(source.s3?.accessKeyId && source.s3?.secretAccessKey);
  const sourceObjectStore = {
    apiVersion: "barmancloud.cnpg.io/v1",
    kind: "ObjectStore",
    metadata: { name: srcStoreName, namespace: ctx.namespace, labels },
    spec: {
      configuration: {
        destinationPath: source.destinationPath,
        ...(source.s3?.endpointURL ? { endpointURL: source.s3.endpointURL } : {}),
        s3Credentials: useSrcStaticCreds
          ? {
              accessKeyId: { name: srcCredsSecretName, key: "ACCESS_KEY_ID" },
              secretAccessKey: { name: srcCredsSecretName, key: "ACCESS_SECRET_KEY" },
            }
          : { inheritFromIAMRole: true },
        wal: { compression: "gzip" },
        data: { compression: "gzip" },
      },
    },
  };

  // Swap the base Cluster's bootstrap: initdb → recovery. The recovered `app` database/owner come FROM the
  // backup; `secret` re-sets the owner's password to the branch's own generated creds (credential
  // isolation). `recoveryTarget.targetTime` → point-in-time when `--at` was given. externalClusters wires
  // the source ObjectStore via the plugin (barmanObjectName + the source's serverName under the root) —
  // the plugin path, matching how `databaseManifests` archives (NOT the deprecated inline barmanObjectStore).
  const cluster = {
    ...base.cluster,
    spec: {
      ...(base.cluster as { spec: Record<string, unknown> }).spec,
      bootstrap: {
        recovery: {
          source: srcStoreName,
          database: "app",
          owner: "app",
          secret: { name: `${ctx.name}-app` },
          ...(source.targetTime ? { recoveryTarget: { targetTime: source.targetTime } } : {}),
        },
      },
      externalClusters: [
        {
          name: srcStoreName,
          plugin: { name: PLUGIN_NAME, parameters: { barmanObjectName: srcStoreName, serverName: source.clusterName } },
        },
      ],
    },
  };

  const out: RecoveryDatabaseManifests = { ...base, cluster, sourceObjectStore };
  if (useSrcStaticCreds) {
    out.sourceSecret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: srcCredsSecretName, namespace: ctx.namespace, labels },
      stringData: { ACCESS_KEY_ID: source.s3!.accessKeyId, ACCESS_SECRET_KEY: source.s3!.secretAccessKey },
    };
  }
  return out;
}

/** An on-demand CNPG Backup object, run through the Barman Cloud Plugin (NOT the deprecated
 *  in-tree barmanObjectStore — method:plugin is required, matching the ScheduledBackup). The
 *  caller mints a unique, DNS-safe `name`. `storeName` is the cluster's ObjectStore (`<cluster>-store`). */
export function databaseBackupManifest(ctx: { name: string; cluster: string; namespace: string; storeName: string }): Record<string, unknown> {
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: {
      name: ctx.name,
      namespace: ctx.namespace,
      labels: { "app.kubernetes.io/managed-by": "drop", "drop.dev/workload": ctx.cluster, "cnpg.io/cluster": ctx.cluster },
    },
    spec: {
      cluster: { name: ctx.cluster },
      method: "plugin", // MUST be explicit — the default is the deprecated barmanObjectStore path
      pluginConfiguration: { name: PLUGIN_NAME, parameters: { barmanObjectName: ctx.storeName } },
    },
  };
}

export type PoolerMode = "transaction" | "session";

export interface PoolerContext {
  name: string; // the CNPG Cluster name
  namespace: string; // tenant namespace
  mode: PoolerMode; // pgbouncer pool mode; "transaction" (default) multiplexes per-transaction
}

/** The pooler resource NAME (= its Service name): `<db>-pooler-rw`. The binding's PGHOST override and
 *  the detail `pooler.host` both point here; keep this single source of truth. */
export function poolerName(dbName: string): string {
  return `${dbName}-pooler-rw`;
}

/** (I3) A CNPG first-class Pooler (PgBouncer) fronting the cluster's PRIMARY (type: rw). One instance;
 *  the pool mode is pgbouncer's poolMode. The Pooler's own Service takes the Pooler's name
 *  (`<db>-pooler-rw`), which is what an app with `uses: [{ database, via: pooler }]` targets. */
export function poolerManifest(ctx: PoolerContext): Record<string, unknown> {
  const name = poolerName(ctx.name);
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Pooler",
    metadata: {
      name,
      namespace: ctx.namespace,
      labels: { "app.kubernetes.io/managed-by": "drop", "drop.dev/workload": ctx.name, "drop.dev/kind": "pooler" },
    },
    spec: {
      cluster: { name: ctx.name },
      instances: 1,
      type: "rw", // front the primary (read-write); a read-only pooler is out of scope for v1
      pgbouncer: { poolMode: ctx.mode },
    },
  };
}

export interface PasswordJobContext {
  name: string; // the CNPG Cluster name (rw service = `<name>-rw`, creds Secret = `<name>-app`)
  namespace: string;
  image: string; // operand image (carries psql); from the live Cluster .status.image
}

export const PWSET_SECRET = (name: string) => `${name}-pwset`; // short-lived Secret holding NEWPW

/** A one-shot Job that rotates the managed DB's `app` password by ALTERing the role from
 *  INSIDE the tenant namespace (a role may change its OWN password — no superuser needed).
 *  It connects as `app` with the CURRENT password (mounted from the `<name>-app` Secret) and
 *  runs `ALTER ROLE app PASSWORD :'newpw'`, where `newpw` is loaded from the NEWPW env var via
 *  psql's `\getenv` and server-side-quoted by `:'…'` — so an arbitrary password can never break
 *  out into SQL. BOTH passwords arrive via secretKeyRef (no plaintext in the Job/Pod spec or the
 *  apiserver audit log). The caller updates the `<name>-app` Secret to match AFTER success. */
export function databasePasswordJob(ctx: PasswordJobContext): Record<string, unknown> {
  const jobName = `${ctx.name}-pwset`;
  const labels = { "app.kubernetes.io/managed-by": "drop", "drop.dev/workload": ctx.name, "drop.dev/job": "pwset" };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName, namespace: ctx.namespace, labels },
    spec: {
      backoffLimit: 2,
      // Bounds the worst case server-side. Retry budget below: 10 × (≤2×4s connect + 2s) ≈ 100s < 120.
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 120, // belt-and-suspenders: auto-GC even if the caller's delete is missed
      template: {
        // app.kubernetes.io/name=<job> lets getWorkloadLogs surface this Job's pod logs on failure.
        metadata: { labels: { ...labels, "app.kubernetes.io/name": jobName } },
        spec: {
          restartPolicy: "Never",
          securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "pwset",
              image: ctx.image,
              command: ["sh", "-c"],
              // \getenv pulls NEWPW into a psql var; :'newpw' quotes it server-side so an arbitrary
              // password can never break out of the SQL.
              // IDEMPOTENT RETRY LOOP, for two failure modes a one-shot would mishandle:
              //  (a) CNI NetworkPolicy programming race — a freshly-scheduled pod's first egress is
              //      REJECTed ("connection refused"); retry until the rules land.
              //  (b) connection dropped AFTER the server committed the ALTER but before psql saw the
              //      ack — the role is already the NEW password. So EACH iteration first PROBES with
              //      NEWPW: if that already authenticates, the rotation is done → exit 0. Only if it
              //      doesn't do we connect with the CURRENT creds and run the ALTER. This makes the
              //      whole Job safe to retry and self-healing across pod restarts.
              args: [
                "printf '%s\\n' '\\getenv newpw NEWPW' \"ALTER ROLE app PASSWORD :'newpw';\" > /tmp/rotate.sql\n" +
                  "for i in $(seq 1 10); do " +
                  'PGPASSWORD="$NEWPW" psql -tAc "select 1" >/dev/null 2>&1 && exit 0; ' + // already rotated?
                  "psql -v ON_ERROR_STOP=1 -f /tmp/rotate.sql && exit 0; " + // else set it with current creds
                  'echo "pwset: attempt $i did not complete, retrying in 2s" >&2; sleep 2; done; exit 1\n',
              ],
              env: [
                { name: "PGHOST", value: `${ctx.name}-rw` },
                { name: "PGPORT", value: "5432" },
                { name: "PGUSER", value: "app" },
                { name: "PGDATABASE", value: "app" },
                { name: "PGCONNECT_TIMEOUT", value: "4" },
                { name: "PGPASSWORD", valueFrom: { secretKeyRef: { name: `${ctx.name}-app`, key: "password" } } }, // current creds
                { name: "NEWPW", valueFrom: { secretKeyRef: { name: jobName, key: "NEWPW" } } }, // target (short-lived Secret)
              ],
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            },
          ],
        },
      },
    },
  };
}
