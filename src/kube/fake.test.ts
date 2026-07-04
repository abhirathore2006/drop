import { test, expect } from "bun:test";
import { FakeKube } from "./fake.ts";
import { appManifests } from "./manifests.ts";

test("FakeKube records applies, serves getApp, and deletes", async () => {
  const k = new FakeKube();
  const m = appManifests({ image: "x:1", services: [{ internalPort: 8080, protocol: "http" }] }, {
    name: "billing",
    namespace: "drop-acme",
    host: "billing.drop.example.com",
  });

  expect(await k.getApp("drop-acme", "billing")).toBeNull();
  await k.applyApp("drop-acme", "billing", m);
  expect(k.applies).toHaveLength(1);
  expect(await k.getApp("drop-acme", "billing")).toBe(m);

  await k.deleteApp("drop-acme", "billing");
  expect(await k.getApp("drop-acme", "billing")).toBeNull();
  expect(k.deletes).toEqual([{ namespace: "drop-acme", name: "billing" }]);
});

test("FakeKube records applyTenant", async () => {
  const { FakeKube } = await import("./fake.ts");
  const { tenantManifests } = await import("./manifests.ts");
  const k = new FakeKube();
  await k.applyTenant("drop-t-x", tenantManifests("drop-t-x"));
  expect(k.tenantApplies).toHaveLength(1);
  expect(k.tenantApplies[0]!.namespace).toBe("drop-t-x");
});

// ---- G1: scriptable follow-log stream ----

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream as any) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

test("getWorkloadLogsStream: unscripted namespace/name -> null", async () => {
  const k = new FakeKube();
  expect(await k.getWorkloadLogsStream("ns", "nope")).toBeNull();
});

test("getWorkloadLogsStream: emits the scripted lines then ends", async () => {
  const k = new FakeKube();
  k.scriptedLogStreams.set("ns/billing", { lines: ["one", "two", "three"] });
  const stream = await k.getWorkloadLogsStream("ns", "billing");
  expect(stream).not.toBeNull();
  expect(await drain(stream!)).toBe("one\ntwo\nthree\n");
});

test("getWorkloadLogsStream: aborting the signal destroys a keepOpen stream and records the abort", async () => {
  const k = new FakeKube();
  k.scriptedLogStreams.set("ns/billing", { lines: ["one"], keepOpen: true });
  const controller = new AbortController();
  const stream = await k.getWorkloadLogsStream("ns", "billing", { signal: controller.signal });
  expect(stream!.destroyed).toBe(false);
  controller.abort();
  expect(k.logStreamAborts).toEqual([{ namespace: "ns", name: "billing" }]);
  expect(stream!.destroyed).toBe(true);
});

// ---- H2: schedule (cron) ----

test("FakeKube: deleteApp removes a cron app's manifests (including the cronJob)", async () => {
  const k = new FakeKube();
  const m = appManifests({ image: "cron:1", services: [{ internalPort: 8080, protocol: "http" }], schedule: "0 3 * * *" }, {
    name: "nightly",
    namespace: "drop-acme",
    host: "nightly.drop.example.com",
  });
  expect(m.cronJob).toBeDefined();
  expect(m.deployment).toBeUndefined();

  await k.applyApp("drop-acme", "nightly", m);
  expect((await k.getApp("drop-acme", "nightly"))?.cronJob).toEqual(m.cronJob); // bookkeeping carries the cronjob manifest

  await k.deleteApp("drop-acme", "nightly");
  expect(await k.getApp("drop-acme", "nightly")).toBeNull(); // cronJob gone along with everything else
  expect(k.deletes).toEqual([{ namespace: "drop-acme", name: "nightly" }]);
});

test("FakeKube: stopApp suspends a cron app's CronJob; startApp unsuspends it", async () => {
  const k = new FakeKube();
  const m = appManifests({ image: "cron:1", services: [{ internalPort: 8080, protocol: "http" }], schedule: "0 3 * * *" }, {
    name: "nightly",
    namespace: "drop-acme",
    host: "h",
  });
  await k.applyApp("drop-acme", "nightly", m);
  expect((m.cronJob as any).spec.suspend).toBeUndefined();

  await k.stopApp("drop-acme", "nightly");
  expect(k.stopped.has("drop-acme/nightly")).toBe(true); // generic bookkeeping, same as any app
  expect(((await k.getApp("drop-acme", "nightly"))!.cronJob as any).spec.suspend).toBe(true);

  await k.startApp("drop-acme", "nightly");
  expect(k.stopped.has("drop-acme/nightly")).toBe(false);
  expect(((await k.getApp("drop-acme", "nightly"))!.cronJob as any).spec.suspend).toBe(false);
});

test("FakeKube: stopApp/startApp on a NON-cron app never touch a cronJob field (there isn't one)", async () => {
  const k = new FakeKube();
  const m = appManifests({ image: "x:1", services: [{ internalPort: 8080, protocol: "http" }] }, { name: "billing", namespace: "ns", host: "h" });
  await k.applyApp("ns", "billing", m);
  await k.stopApp("ns", "billing"); // must not throw despite no cronJob present
  expect(k.stopped.has("ns/billing")).toBe(true);
  await k.startApp("ns", "billing");
  expect(k.stopped.has("ns/billing")).toBe(false);
});

// ---- L1b: queue-scaled workers (KEDA) ----

test("FakeKube: applyApp carries a scale_on worker's ScaledObject/TriggerAuthentication; deleteApp clears them", async () => {
  const k = new FakeKube();
  const m = appManifests(
    {
      image: "app:1",
      services: [{ internalPort: 8080, protocol: "http" }],
      uses: [{ cache: "sessions" }],
      processes: { web: {}, worker: { command: "node worker.js", scaleOn: { queue: "jobs", target: 10 } } },
    },
    { name: "app", namespace: "drop-acme", host: "app.example.com" },
  );
  expect(m.workers![0]!.scaledObject).toBeDefined();
  expect(m.workers![0]!.triggerAuth).toBeDefined();

  await k.applyApp("drop-acme", "app", m);
  const applied = await k.getApp("drop-acme", "app");
  expect(applied!.workers![0]!.scaledObject).toEqual(m.workers![0]!.scaledObject);
  expect(applied!.workers![0]!.triggerAuth).toEqual(m.workers![0]!.triggerAuth);

  await k.deleteApp("drop-acme", "app");
  expect(await k.getApp("drop-acme", "app")).toBeNull(); // ScaledObject/TriggerAuthentication gone with everything else
});

test("FakeKube: toggling scale_on off (redeploy without it) drops the ScaledObject/TriggerAuthentication from the stored manifests", async () => {
  const k = new FakeKube();
  const withScaleOn = appManifests(
    {
      image: "app:1",
      services: [{ internalPort: 8080, protocol: "http" }],
      uses: [{ cache: "sessions" }],
      processes: { worker: { command: "w", scaleOn: { queue: "jobs", target: 10 } } },
    },
    { name: "app", namespace: "ns", host: "h" },
  );
  await k.applyApp("ns", "app", withScaleOn);
  expect((await k.getApp("ns", "app"))!.workers![0]!.scaledObject).toBeDefined();

  // redeploy the SAME app, `scale_on` removed
  const withoutScaleOn = appManifests(
    { image: "app:1", services: [{ internalPort: 8080, protocol: "http" }], processes: { worker: { command: "w" } } },
    { name: "app", namespace: "ns", host: "h" },
  );
  await k.applyApp("ns", "app", withoutScaleOn);
  const now = await k.getApp("ns", "app");
  expect(now!.workers![0]!.scaledObject).toBeUndefined();
  expect(now!.workers![0]!.triggerAuth).toBeUndefined();
});

// ---- C1: aggregated namespace status lists ----

test("listNamespace{App,Database}Statuses: scoped to the namespace, honor overrides", async () => {
  const k = new FakeKube();
  const m = appManifests({ image: "x:1", services: [{ internalPort: 8080, protocol: "http" }] }, { name: "api", namespace: "drop-a", host: "api.x" });
  await k.applyApp("drop-a", "api", m);
  await k.applyApp("drop-b", "other", m); // a DIFFERENT namespace — must not leak in
  await k.applyDatabase("drop-a", "pg", {} as any);

  // a crash reason set on the app surfaces through the aggregated list
  k.statusOverride.set("drop-a/api", { replicas: 1, ready: 0, restarts: 3, reason: "CrashLoopBackOff" });

  const apps = await k.listNamespaceAppStatuses("drop-a");
  expect(Object.keys(apps)).toEqual(["api"]); // 'other' is in drop-b
  expect(apps.api).toEqual({ replicas: 1, ready: 0, restarts: 3, reason: "CrashLoopBackOff" });

  const dbs = await k.listNamespaceDatabaseStatuses("drop-a");
  expect(Object.keys(dbs)).toEqual(["pg"]);
  expect(dbs.pg.phase).toBe("Cluster in healthy state");

  // an empty namespace yields empty maps (never throws)
  expect(await k.listNamespaceAppStatuses("drop-empty")).toEqual({});
  expect(await k.listNamespaceDatabaseStatuses("drop-empty")).toEqual({});
});
