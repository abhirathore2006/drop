import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { FakeBlob } from "../blob/fake.ts";
import { FakeKube } from "../kube/fake.ts";
import { LogCollector, shouldCollectLogs } from "./collector.ts";
import { parseNdjsonGz, logObjectKey, hourStart } from "./format.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  const blob = new FakeBlob();
  const kube = new FakeKube();
  return { db, meta, orgs, blob, kube };
}

/** Deploy a RUNNING workload with a current version carrying `config` (the logRetention flag lives there). */
async function deploy(
  t: { meta: MetaStore; orgs: OrgStore },
  name: string,
  type: "app" | "database",
  config: Record<string, unknown> = {},
) {
  const o = await t.orgs.ensurePersonalOrg("alice@x.com");
  await t.meta.claimSite(name, "alice@x.com", type, { id: o.id, namespace: o.namespace });
  await t.meta.putVersion(name, { id: "v1", publishedBy: "alice@x.com", createdAt: "2026-07-04T00:00:00.000Z", fileCount: 0, bytes: 0, config: config as never });
  await t.meta.updateSite(name, (s) => ({ ...s, currentVersion: "v1" }));
  return o;
}

async function readObject(blob: FakeBlob, key: string) {
  const res = await blob.get(key);
  if (!res) return null;
  return parseNdjsonGz(new Uint8Array(await new Response(res.body).arrayBuffer()));
}

test("shouldCollectLogs: apps/sites default ON (opt-out); databases default OFF (opt-in)", () => {
  expect(shouldCollectLogs("app")).toBe(true);
  expect(shouldCollectLogs("app", false)).toBe(false); // opt-out
  expect(shouldCollectLogs("app", true)).toBe(true);
  expect(shouldCollectLogs("site")).toBe(true);
  expect(shouldCollectLogs("database")).toBe(false); // excluded by default
  expect(shouldCollectLogs("database", false)).toBe(false);
  expect(shouldCollectLogs("database", true)).toBe(true); // opt-in
});

test("ingest → flush writes ONE gzipped NDJSON object per (site,hour) with the {ts,site,pod,stream,line} shape + an index row", async () => {
  const { db, meta, orgs, blob, kube } = await fix();
  const at = new Date("2026-07-04T10:15:00.000Z");
  const collector = new LogCollector({ meta, kube, blob, now: () => at });

  collector.ingest("web", "web", "stdout", "boot ok", at);
  collector.ingest("web", "web", "stdout", "serving :8080", at);
  const written = await collector.flush();
  expect(written).toBe(1);

  const key = logObjectKey("web", hourStart(at));
  expect(key).toBe("logs/web/2026-07-04T10.ndjson.gz");
  const records = await readObject(blob, key);
  expect(records).toEqual([
    { ts: at.toISOString(), site: "web", pod: "web", stream: "stdout", line: "boot ok" },
    { ts: at.toISOString(), site: "web", pod: "web", stream: "stdout", line: "serving :8080" },
  ]);

  // exactly one index row for the object, pointing at the same key
  const rows = await meta.listLogObjectsInRange("web", new Date("2026-07-04T00:00:00Z"), new Date("2026-07-04T23:00:00Z"));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.key).toBe(key);
  await db.destroy();
});

test("flush buckets lines by HOUR — separate object + index row per hour", async () => {
  const { db, meta, orgs, blob, kube } = await fix();
  let clock = new Date("2026-07-04T10:59:59.000Z");
  const collector = new LogCollector({ meta, kube, blob, now: () => clock });
  collector.ingest("web", "web", "stdout", "in hour 10", new Date("2026-07-04T10:30:00Z"));
  collector.ingest("web", "web", "stdout", "in hour 11", new Date("2026-07-04T11:05:00Z"));
  clock = new Date("2026-07-04T11:10:00.000Z"); // now past hour 10, so it's flushed then evicted
  const written = await collector.flush();
  expect(written).toBe(2);

  const h10 = await readObject(blob, logObjectKey("web", new Date("2026-07-04T10:00:00Z")));
  const h11 = await readObject(blob, logObjectKey("web", new Date("2026-07-04T11:00:00Z")));
  expect(h10!.map((r) => r.line)).toEqual(["in hour 10"]);
  expect(h11!.map((r) => r.line)).toEqual(["in hour 11"]);

  const rows = await meta.listLogObjectsInRange("web", new Date("2026-07-04T00:00:00Z"), new Date("2026-07-04T23:00:00Z"));
  expect(rows).toHaveLength(2); // one per hour
  await db.destroy();
});

test("a re-flush within the same hour REWRITES the object with the full accumulated set (upsert, not duplicate)", async () => {
  const { db, meta, orgs, blob, kube } = await fix();
  const at = new Date("2026-07-04T10:15:00.000Z");
  const collector = new LogCollector({ meta, kube, blob, now: () => at });
  collector.ingest("web", "web", "stdout", "one", at);
  await collector.flush();
  collector.ingest("web", "web", "stdout", "two", at);
  await collector.flush();

  const records = await readObject(blob, logObjectKey("web", hourStart(at)));
  expect(records!.map((r) => r.line)).toEqual(["one", "two"]); // full hour, not just the delta
  const rows = await meta.listLogObjectsInRange("web", new Date("2026-07-04T00:00:00Z"), new Date("2026-07-04T23:00:00Z"));
  expect(rows).toHaveLength(1); // still ONE index row (upsert on the PK)
  await db.destroy();
});

test("per-hour line cap (ring) bounds memory — the object holds at most maxLinesPerHour", async () => {
  const { db, meta, orgs, blob, kube } = await fix();
  const at = new Date("2026-07-04T10:00:00.000Z");
  const collector = new LogCollector({ meta, kube, blob, maxLinesPerHour: 3, now: () => at });
  for (let i = 0; i < 6; i++) collector.ingest("web", "web", "stdout", `line ${i}`, at);
  await collector.flush();
  const records = await readObject(blob, logObjectKey("web", hourStart(at)));
  expect(records!.map((r) => r.line)).toEqual(["line 3", "line 4", "line 5"]); // oldest dropped
  await db.destroy();
});

test("reconcile tails RUNNING apps + opted-in DBs; DBs are excluded by default (fan-out bound)", async () => {
  const { db, meta, orgs, blob, kube } = await fix();
  await deploy({ meta, orgs }, "web", "app"); // default on
  await deploy({ meta, orgs }, "noisy", "app", { logRetention: false }); // opt-out
  await deploy({ meta, orgs }, "pg", "database"); // excluded by default
  await deploy({ meta, orgs }, "vecdb", "database", { logRetention: true }); // opt-in
  const ns = (await meta.getSitePlain("web"))!.namespace;
  // keepOpen so the tails stay active for the activeTails assertion
  for (const n of ["web", "vecdb"]) kube.scriptedLogStreams.set(`${ns}/${n}`, { lines: [`${n} up`], keepOpen: true });

  const collector = new LogCollector({ meta, kube, blob });
  await collector.reconcile();

  expect(collector.activeTails()).toEqual(["vecdb", "web"]); // NOT noisy (opt-out), NOT pg (db default off)
  const tailed = kube.logStreamCalls.map((c) => c.name).sort();
  expect(tailed).toEqual(["vecdb", "web"]);
  collector.stop();
  await db.destroy();
});

test("reconcile honors the concurrent-tail cap", async () => {
  const { db, meta, orgs, blob, kube } = await fix();
  for (const n of ["a", "b", "c"]) await deploy({ meta, orgs }, n, "app");
  const ns = (await meta.getSitePlain("a"))!.namespace;
  for (const n of ["a", "b", "c"]) kube.scriptedLogStreams.set(`${ns}/${n}`, { lines: ["x"], keepOpen: true });
  const collector = new LogCollector({ meta, kube, blob, maxConcurrentTails: 2 });
  await collector.reconcile();
  expect(collector.activeTails()).toHaveLength(2); // capped at 2 of the 3 running apps
  collector.stop();
  await db.destroy();
});

test("a stopped/deleted workload's tail is torn down on the next reconcile", async () => {
  const { db, meta, orgs, blob, kube } = await fix();
  await deploy({ meta, orgs }, "web", "app");
  const ns = (await meta.getSitePlain("web"))!.namespace;
  kube.scriptedLogStreams.set(`${ns}/web`, { lines: ["up"], keepOpen: true });
  const collector = new LogCollector({ meta, kube, blob });
  await collector.reconcile();
  expect(collector.activeTails()).toEqual(["web"]);
  await meta.setRuntimeState("web", "stopped");
  await collector.reconcile();
  expect(collector.activeTails()).toEqual([]); // no longer running → tail aborted
  await db.destroy();
});

test("a finite stream drains into buckets; a restart resumes from sinceTime (at-least-once, no full re-ingest)", async () => {
  const { db, meta, orgs, blob, kube } = await fix();
  await deploy({ meta, orgs }, "web", "app");
  const ns = (await meta.getSitePlain("web"))!.namespace;
  kube.scriptedLogStreams.set(`${ns}/web`, { lines: ["hello", "world"] }); // finite: ends after 2 lines
  const collector = new LogCollector({ meta, kube, blob });

  await collector.reconcile(); // opens + pumps the finite stream
  await collector.idle(); // wait for the stream to drain
  expect(collector.activeTails()).toEqual([]); // finite stream ended → tail removed
  await collector.flush();
  const records = await readObject(blob, logObjectKey("web", hourStart(new Date())));
  expect(records!.map((r) => r.line)).toEqual(["hello", "world"]);

  // First call used tailLines (no prior sinceTime); the restart passes sinceTime = last-seen line ts.
  expect(kube.logStreamCalls[0]!.sinceTime).toBeUndefined();
  expect(kube.logStreamCalls[0]!.tailLines).toBeGreaterThan(0);
  kube.scriptedLogStreams.set(`${ns}/web`, { lines: ["again"] });
  await collector.reconcile();
  await collector.idle();
  expect(kube.logStreamCalls[1]!.sinceTime).toBe(records![records!.length - 1]!.ts);
  await db.destroy();
});
