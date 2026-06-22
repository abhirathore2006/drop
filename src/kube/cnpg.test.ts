import { test, expect } from "bun:test";
import { databaseManifests } from "./cnpg.ts";
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
