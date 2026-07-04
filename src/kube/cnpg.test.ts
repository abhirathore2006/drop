import { test, expect } from "bun:test";
import { databaseManifests, recoveryDatabaseManifests, databasePasswordJob, poolerManifest, poolerName } from "./cnpg.ts";
import type { DatabaseConfig } from "../db-config.ts";

const base: DatabaseConfig = { engine: "postgres-18", storage: "10Gi", hibernation: "none" };

const localCtx = {
  name: "billing-db",
  namespace: "drop-t-alice",
  destinationPath: "s3://drop/databases/drop-t-alice/billing-db",
  s3: { endpointURL: "http://floci:4566", accessKeyId: "test", secretAccessKey: "test" },
};

test("databaseManifests: ObjectStore is barmancloud.cnpg.io/v1 with the configured destination + local S3", () => {
  const m = databaseManifests(base, localCtx);
  const os = m.objectStore as any;
  expect(os.apiVersion).toBe("barmancloud.cnpg.io/v1"); // NOT postgres(ql).cnpg.io
  expect(os.kind).toBe("ObjectStore");
  expect(os.metadata.namespace).toBe("drop-t-alice");
  expect(os.spec.configuration.destinationPath).toBe("s3://drop/databases/drop-t-alice/billing-db");
  expect(os.spec.configuration.endpointURL).toBe("http://floci:4566"); // local Floci only
  expect(os.spec.configuration.s3Credentials.accessKeyId.name).toBe("billing-db-backup-creds");
  expect(os.spec.configuration.s3Credentials.accessKeyId.key).toBe("ACCESS_KEY_ID");
  expect(os.spec.configuration.s3Credentials.secretAccessKey.key).toBe("ACCESS_SECRET_KEY");
  expect(os.spec.configuration.wal.compression).toBe("gzip");
  expect(os.spec.configuration.data.compression).toBe("gzip");
});

test("databaseManifests: local S3 creds Secret is emitted; prod (IRSA) omits it", () => {
  const local = databaseManifests(base, localCtx);
  expect((local.secret as any).kind).toBe("Secret");
  expect((local.secret as any).metadata.name).toBe("billing-db-backup-creds");
  expect((local.secret as any).stringData.ACCESS_KEY_ID).toBe("test");
  expect((local.secret as any).stringData.ACCESS_SECRET_KEY).toBe("test");

  const prod = databaseManifests(base, {
    name: "billing-db",
    namespace: "drop-t-alice",
    destinationPath: "s3://drop-prod/db/billing-db",
    iamRoleArn: "arn:aws:iam::123:role/drop-db",
  });
  expect(prod.secret).toBeUndefined(); // IRSA → no static creds Secret
  const os = prod.objectStore as any;
  expect(os.spec.configuration.endpointURL).toBeUndefined(); // real S3 → default endpoint
  expect(os.spec.configuration.s3Credentials.inheritFromIAMRole).toBe(true);
});

test("databaseManifests: Cluster wires the Barman plugin (not the deprecated inline barmanObjectStore)", () => {
  const m = databaseManifests(base, localCtx);
  const cl = m.cluster as any;
  expect(cl.apiVersion).toBe("postgresql.cnpg.io/v1");
  expect(cl.kind).toBe("Cluster");
  expect(cl.metadata.namespace).toBe("drop-t-alice");
  expect(cl.spec.instances).toBe(1);
  expect(cl.spec.backup).toBeUndefined(); // never emit the deprecated in-tree path
  const plugin = cl.spec.plugins[0];
  expect(plugin.name).toBe("barman-cloud.cloudnative-pg.io");
  expect(plugin.isWALArchiver).toBe(true);
  expect(plugin.parameters.barmanObjectName).toBe("billing-db-store");
  expect(cl.spec.storage.size).toBe("10Gi");
  expect(cl.spec.resources.limits.memory).toBeDefined();
  expect(cl.spec.resources.requests.memory).toBeDefined();
});

test("databaseManifests: appPassword emits a basic-auth creds Secret + bootstraps the Cluster from it; absent on update", () => {
  const create = databaseManifests(base, { ...localCtx, appPassword: "s3cr3t-pw-value" });
  const sec = create.appSecret as any;
  expect(sec.kind).toBe("Secret");
  expect(sec.type).toBe("kubernetes.io/basic-auth");
  expect(sec.metadata.name).toBe("billing-db-app"); // the connection Secret apps read
  expect(sec.stringData.username).toBe("app");
  expect(sec.stringData.password).toBe("s3cr3t-pw-value");
  // the Cluster bootstraps the `app` user/db from THIS Secret (platform-owned, not CNPG-auto)
  const boot = (create.cluster as any).spec.bootstrap.initdb;
  expect(boot.database).toBe("app");
  expect(boot.owner).toBe("app");
  expect(boot.secret.name).toBe("billing-db-app");
  // NOT managed.roles — that path doesn't reliably rotate the bootstrap app user's password.
  expect((create.cluster as any).spec.managed).toBeUndefined();

  // update (no appPassword): the Secret is NOT re-emitted (never silently rotate), but the
  // immutable bootstrap ref is still present in the desired spec.
  const update = databaseManifests(base, localCtx);
  expect(update.appSecret).toBeUndefined();
  expect((update.cluster as any).spec.bootstrap.initdb.secret.name).toBe("billing-db-app");
});

test("databasePasswordJob: idempotent in-namespace ALTER, injection-safe, secret-sourced, locked-down", () => {
  const job = databasePasswordJob({ name: "billing-db", namespace: "drop-t-alice", image: "ghcr.io/x/pg:18" }) as any;
  expect(job.kind).toBe("Job");
  expect(job.metadata.name).toBe("billing-db-pwset");
  expect(job.metadata.namespace).toBe("drop-t-alice");
  expect(job.spec.ttlSecondsAfterFinished).toBeGreaterThan(0); // auto-GC even if the caller's delete is missed
  expect(job.spec.activeDeadlineSeconds).toBeGreaterThan(0); // a stuck connect can't pin it open forever
  const c = job.spec.template.spec.containers[0];
  expect(c.image).toBe("ghcr.io/x/pg:18");
  // newpw is read from env via \getenv and server-side-quoted (:'newpw') — never interpolated
  // into the SQL string, so an arbitrary password can't break out.
  const sql = c.args.join("\n");
  expect(sql).toContain("\\getenv newpw NEWPW");
  expect(sql).toContain("ALTER ROLE app PASSWORD :'newpw'");
  expect(sql).toContain('PGPASSWORD="$NEWPW"'); // idempotent probe: if NEWPW already works → exit 0
  const env = Object.fromEntries(c.env.map((e: any) => [e.name, e]));
  // BOTH passwords arrive via secretKeyRef — NO plaintext password in the Job/Pod spec (or audit log).
  expect(env.NEWPW.value).toBeUndefined();
  expect(env.NEWPW.valueFrom.secretKeyRef.name).toBe("billing-db-pwset"); // short-lived NEWPW Secret
  expect(env.NEWPW.valueFrom.secretKeyRef.key).toBe("NEWPW");
  expect(env.PGUSER.value).toBe("app");
  expect(env.PGHOST.value).toBe("billing-db-rw");
  expect(env.PGPASSWORD.valueFrom.secretKeyRef.name).toBe("billing-db-app"); // connect with CURRENT creds
  expect(env.PGPASSWORD.valueFrom.secretKeyRef.key).toBe("password");
  // hardened pod (no priv-esc, all caps dropped, non-root)
  expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
  expect(c.securityContext.capabilities.drop).toEqual(["ALL"]);
  expect(job.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
  expect(job.spec.template.spec.restartPolicy).toBe("Never");
});

test("databaseManifests: prod Cluster sets the IRSA serviceAccountTemplate annotation", () => {
  const prod = databaseManifests(base, {
    name: "billing-db",
    namespace: "drop-t-alice",
    destinationPath: "s3://drop-prod/db/billing-db",
    iamRoleArn: "arn:aws:iam::123:role/drop-db",
  });
  const cl = prod.cluster as any;
  expect(cl.spec.serviceAccountTemplate.metadata.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123:role/drop-db");
});

test("databaseManifests: ScheduledBackup uses method:plugin + a 6-field (seconds-first) cron", () => {
  const m = databaseManifests(base, localCtx);
  const sb = m.scheduledBackup as any;
  expect(sb.apiVersion).toBe("postgresql.cnpg.io/v1");
  expect(sb.kind).toBe("ScheduledBackup");
  expect(sb.spec.method).toBe("plugin"); // default is the deprecated barmanObjectStore — must be explicit
  expect(sb.spec.cluster.name).toBe("billing-db");
  expect(sb.spec.pluginConfiguration.name).toBe("barman-cloud.cloudnative-pg.io");
  expect(sb.spec.pluginConfiguration.parameters.barmanObjectName).toBe("billing-db-store");
  expect(sb.spec.schedule.split(/\s+/)).toHaveLength(6); // 6-field: sec min hour dom mon dow
});

test("databaseManifests: NetworkPolicy lets cnpg-system manage the DB pods; egress is SCOPED (no blanket 0.0.0.0/0, no cross-tenant 5432)", () => {
  const m = databaseManifests(base, { ...localCtx, apiServerCidrs: ["172.20.0.0/16", "100.64.0.0/10"] });
  const np = m.networkPolicy as any;
  expect(np.kind).toBe("NetworkPolicy");
  expect(np.metadata.namespace).toBe("drop-t-alice");
  expect(np.spec.podSelector.matchLabels["cnpg.io/cluster"]).toBe("billing-db");
  expect(np.spec.policyTypes).toEqual(["Ingress", "Egress"]);
  // ingress from the cnpg-system namespace (operator manages instances)
  const fromCnpg = np.spec.ingress.some(
    (r: any) => (r.from ?? []).some((f: any) => f.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "cnpg-system"),
  );
  expect(fromCnpg).toBe(true);
  // SECURITY: every egress rule must have a destination selector — a `to`-less rule means
  // "all destinations" and (additive with the tenant policy) would re-open 0.0.0.0/0.
  for (const r of np.spec.egress) expect(r.to).toBeDefined();
  // the API-server rule is scoped to the configured cluster CIDRs on 443/6443 only
  const api = np.spec.egress.find((r: any) => (r.ports ?? []).some((p: any) => p.port === 443));
  expect(api.to.map((t: any) => t.ipBlock.cidr).sort()).toEqual(["100.64.0.0/10", "172.20.0.0/16"]);
  expect(api.ports.map((p: any) => p.port).sort()).toEqual([443, 6443]);
  // no egress rule opens cross-tenant Postgres (5432) cluster-wide
  const has5432ToAll = np.spec.egress.some(
    (r: any) => (r.ports ?? []).some((p: any) => p.port === 5432) && (!r.to || r.to.some((t: any) => t.ipBlock?.cidr === "0.0.0.0/0")),
  );
  expect(has5432ToAll).toBe(false);
});

test("databaseManifests: objectStoreEgress adds a scoped egress to a non-443 local store (Floci/MinIO)", () => {
  const m = databaseManifests(base, { ...localCtx, objectStoreEgress: { cidr: "10.88.0.0/16", port: 4566 } });
  const egress = (m.networkPolicy as any).spec.egress;
  const store = egress.find((r: any) => (r.ports ?? []).some((p: any) => p.port === 4566));
  expect(store).toBeDefined();
  expect(store.to).toEqual([{ ipBlock: { cidr: "10.88.0.0/16" } }]); // scoped to the store CIDR, not 0.0.0.0/0
  // and it's still absent by default (prod S3 = 443, covered by the tenant policy)
  const none = (databaseManifests(base, localCtx).networkPolicy as any).spec.egress.some((r: any) => (r.ports ?? []).some((p: any) => p.port === 4566));
  expect(none).toBe(false);
});

test("databaseManifests: hibernation:scheduled labels the Cluster for the idle CronJob", () => {
  const off = databaseManifests(base, localCtx).cluster as any;
  expect(off.metadata.labels["drop.dev/hibernation"]).toBe("none");
  const on = databaseManifests({ ...base, hibernation: "scheduled" }, localCtx).cluster as any;
  expect(on.metadata.labels["drop.dev/hibernation"]).toBe("scheduled");
});

// ---- (I3) extensions + pooler ----------------------------------------------------------------
test("databaseManifests: extensions render as postInitApplicationSQL CREATE EXTENSION (pgvector → vector)", () => {
  const m = databaseManifests({ ...base, extensions: ["pgvector", "pg_trgm"] }, localCtx);
  const initdb = (m.cluster as any).spec.bootstrap.initdb;
  expect(initdb.postInitApplicationSQL).toEqual([
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
  ]);
});

test("databaseManifests: no extensions → no postInitApplicationSQL key", () => {
  const m = databaseManifests(base, localCtx);
  expect((m.cluster as any).spec.bootstrap.initdb.postInitApplicationSQL).toBeUndefined();
});

// ---- (L2) database branching — recoveryDatabaseManifests (shared with FM item 9) ----------------
const branchCtx = {
  name: "web-p-pr1-db", // the preview's OWN cluster name
  namespace: "drop-t-alice",
  destinationPath: "s3://drop/databases/drop-t-alice/web-p-pr1-db", // the BRANCH's own ongoing-backup path
  s3: { endpointURL: "http://floci:4566", accessKeyId: "test", secretAccessKey: "test" },
  appPassword: "branch-own-pw", // the branch's OWN generated app password (credential isolation)
};
const source = {
  clusterName: "billing-db", // the SOURCE db name == its Barman serverName
  destinationPath: "s3://drop/databases/drop-t-alice/billing-db", // the SOURCE's backup root (read-only)
  s3: { endpointURL: "http://floci:4566", accessKeyId: "test", secretAccessKey: "test" },
};

test("recoveryDatabaseManifests: Cluster bootstraps via bootstrap.recovery from the source ObjectStore — NEVER a live volume", () => {
  const m = recoveryDatabaseManifests(base, branchCtx, { source });
  const spec = (m.cluster as any).spec;
  // recovery bootstrap, NOT initdb — and NEVER pg_basebackup (that would stream from the live primary)
  expect(spec.bootstrap.recovery).toBeDefined();
  expect(spec.bootstrap.initdb).toBeUndefined();
  expect(spec.bootstrap.pg_basebackup).toBeUndefined();
  expect(spec.bootstrap.recovery.source).toBe("web-p-pr1-db-recovery-src");
  // the external cluster resolves the source backup via the plugin (barmanObjectName + the source's
  // serverName) — an OBJECT-STORE source, never `connectionParameters` (which would be a live connection).
  const ext = spec.externalClusters[0];
  expect(ext.name).toBe("web-p-pr1-db-recovery-src");
  expect(ext.connectionParameters).toBeUndefined();
  expect(ext.plugin.name).toBe("barman-cloud.cloudnative-pg.io");
  expect(ext.plugin.parameters.barmanObjectName).toBe("web-p-pr1-db-recovery-src");
  expect(ext.plugin.parameters.serverName).toBe("billing-db"); // the SOURCE's server dir under its backup root
});

test("recoveryDatabaseManifests: source ObjectStore points at the source backup path + creds (read-only)", () => {
  const m = recoveryDatabaseManifests(base, branchCtx, { source });
  const src = m.sourceObjectStore as any;
  expect(src.apiVersion).toBe("barmancloud.cnpg.io/v1");
  expect(src.kind).toBe("ObjectStore");
  expect(src.metadata.name).toBe("web-p-pr1-db-recovery-src");
  expect(src.metadata.namespace).toBe("drop-t-alice");
  expect(src.spec.configuration.destinationPath).toBe("s3://drop/databases/drop-t-alice/billing-db"); // the SOURCE root
  expect(src.spec.configuration.endpointURL).toBe("http://floci:4566");
  expect(src.spec.configuration.s3Credentials.accessKeyId.name).toBe("web-p-pr1-db-recovery-src-creds");
  // and its local creds Secret is emitted with the source's creds
  const ss = m.sourceSecret as any;
  expect(ss.kind).toBe("Secret");
  expect(ss.metadata.name).toBe("web-p-pr1-db-recovery-src-creds");
  expect(ss.stringData.ACCESS_KEY_ID).toBe("test");
});

test("recoveryDatabaseManifests: the branch keeps its OWN ongoing-backup store + OWN app password (isolated from the source)", () => {
  const m = recoveryDatabaseManifests(base, branchCtx, { source });
  // the branch archives its OWN WAL/backups to its OWN store at its OWN path — never the source's prefix
  const own = m.objectStore as any;
  expect(own.metadata.name).toBe("web-p-pr1-db-store");
  expect(own.spec.configuration.destinationPath).toBe("s3://drop/databases/drop-t-alice/web-p-pr1-db");
  expect((m.cluster as any).spec.plugins[0].parameters.barmanObjectName).toBe("web-p-pr1-db-store"); // WAL archiver → own store
  // own generated app password: a fresh <name>-app basic-auth Secret, and recovery re-sets the app owner to it
  const app = m.appSecret as any;
  expect(app.metadata.name).toBe("web-p-pr1-db-app");
  expect(app.stringData.password).toBe("branch-own-pw");
  const rec = (m.cluster as any).spec.bootstrap.recovery;
  expect(rec.database).toBe("app");
  expect(rec.owner).toBe("app");
  expect(rec.secret.name).toBe("web-p-pr1-db-app"); // CNPG resets the recovered app owner's password to the branch's Secret
});

test("recoveryDatabaseManifests: --at renders recoveryTarget.targetTime; omitted → latest (no recoveryTarget)", () => {
  const withAt = recoveryDatabaseManifests(base, branchCtx, { source: { ...source, targetTime: "2026-07-01T12:00:00.000Z" } });
  expect((withAt.cluster as any).spec.bootstrap.recovery.recoveryTarget.targetTime).toBe("2026-07-01T12:00:00.000Z");
  const latest = recoveryDatabaseManifests(base, branchCtx, { source });
  expect((latest.cluster as any).spec.bootstrap.recovery.recoveryTarget).toBeUndefined();
});

test("recoveryDatabaseManifests: prod (IRSA) omits both creds Secrets and inherits the role on both stores", () => {
  const prod = recoveryDatabaseManifests(base, {
    name: "web-p-pr1-db",
    namespace: "drop-t-alice",
    destinationPath: "s3://drop-prod/db/web-p-pr1-db",
    iamRoleArn: "arn:aws:iam::123:role/drop-db",
    appPassword: "branch-own-pw",
  }, {
    source: { clusterName: "billing-db", destinationPath: "s3://drop-prod/db/billing-db", iamRoleArn: "arn:aws:iam::123:role/drop-db" },
  });
  expect(prod.secret).toBeUndefined(); // own store: IRSA → no static creds Secret
  expect(prod.sourceSecret).toBeUndefined(); // source store: IRSA → no static creds Secret
  expect((prod.sourceObjectStore as any).spec.configuration.s3Credentials.inheritFromIAMRole).toBe(true);
  expect((prod.sourceObjectStore as any).spec.configuration.endpointURL).toBeUndefined(); // real S3
});

test("recoveryDatabaseManifests: NetworkPolicy + ScheduledBackup are the SAME shape as a normal db (so deleteDatabase/the sweep tear it down identically)", () => {
  const m = recoveryDatabaseManifests(base, branchCtx, { source });
  expect((m.networkPolicy as any).metadata.name).toBe("web-p-pr1-db-db");
  expect((m.scheduledBackup as any).metadata.name).toBe("web-p-pr1-db-daily");
  expect((m.scheduledBackup as any).spec.method).toBe("plugin");
});

test("poolerManifest: CNPG Pooler (rw, one instance) named <db>-pooler-rw with the pgbouncer pool mode", () => {
  const p = poolerManifest({ name: "billing-db", namespace: "drop-t-alice", mode: "transaction" });
  expect(poolerName("billing-db")).toBe("billing-db-pooler-rw");
  expect(p.apiVersion).toBe("postgresql.cnpg.io/v1");
  expect(p.kind).toBe("Pooler");
  expect((p.metadata as any).name).toBe("billing-db-pooler-rw");
  expect((p.spec as any)).toEqual({ cluster: { name: "billing-db" }, instances: 1, type: "rw", pgbouncer: { poolMode: "transaction" } });
  // session mode is carried through
  expect((poolerManifest({ name: "billing-db", namespace: "ns", mode: "session" }).spec as any).pgbouncer.poolMode).toBe("session");
});
