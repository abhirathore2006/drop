import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { MetricsStore } from "./store.ts";
import type { Db } from "../db/db.ts";
import type { TrafficRow } from "./collector.ts";

// uptime_checks has a FK to sites.name — seed a real site before recording uptime for it.
async function seedSite(db: Db, name: string): Promise<void> {
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const org = await new OrgStore(db).ensurePersonalOrg("alice@x.com");
  await new MetaStore(db).claimSite(name, "alice@x.com", "site", { id: org.id, namespace: org.namespace });
}

const tr = (siteName: string, over: Partial<TrafficRow> = {}): TrafficRow => ({
  siteName,
  requests: 0,
  bytesIn: 0,
  bytesOut: 0,
  p50Ms: 0,
  p95Ms: 0,
  s2xx: 0,
  s4xx: 0,
  s5xx: 0,
  ...over,
});

const MIN = new Date("2026-07-04T10:00:00.000Z");

test("flushTraffic: two flushes in the SAME minute add up (additive UPSERT merge)", async () => {
  const db = await makeTestDb();
  const store = new MetricsStore(db);
  await store.flushTraffic(MIN, [tr("a", { requests: 10, bytesIn: 100, bytesOut: 200, p50Ms: 20, p95Ms: 100, s2xx: 8, s4xx: 1, s5xx: 1 })]);
  await store.flushTraffic(MIN, [tr("a", { requests: 30, bytesIn: 300, bytesOut: 600, p50Ms: 40, p95Ms: 200, s2xx: 28, s4xx: 1, s5xx: 1 })]);
  const rows = await store.trafficSeries("a", new Date("2026-07-04T00:00:00Z"));
  expect(rows).toHaveLength(1); // merged into one (site, minute) row
  const r = rows[0]!;
  expect(r.requests).toBe(40);
  expect(r.bytesIn).toBe(400);
  expect(r.bytesOut).toBe(800);
  expect(r.s2xx).toBe(36);
  expect(r.s4xx).toBe(2);
  expect(r.s5xx).toBe(2);
  expect(r.p95Ms).toBe(200); // greatest(100, 200)
  expect(r.p50Ms).toBe(35); // request-weighted (20*10 + 40*30) / 40
  await db.destroy();
});

test("flushTraffic: distinct minutes are distinct rows, ordered ascending", async () => {
  const db = await makeTestDb();
  const store = new MetricsStore(db);
  await store.flushTraffic(new Date("2026-07-04T10:02:00Z"), [tr("a", { requests: 2 })]);
  await store.flushTraffic(new Date("2026-07-04T10:00:00Z"), [tr("a", { requests: 1 })]);
  const rows = await store.trafficSeries("a", new Date("2026-07-04T00:00:00Z"));
  expect(rows.map((r) => r.requests)).toEqual([1, 2]); // asc by minute
  await db.destroy();
});

test("flushTraffic: empty rows is a no-op", async () => {
  const db = await makeTestDb();
  const store = new MetricsStore(db);
  await store.flushTraffic(MIN, []); // must not throw
  expect(await store.trafficSeries("a", new Date(0))).toHaveLength(0);
  await db.destroy();
});

test("trafficSeries: scoped to the site + the since window", async () => {
  const db = await makeTestDb();
  const store = new MetricsStore(db);
  await store.flushTraffic(new Date("2026-07-04T09:00:00Z"), [tr("a", { requests: 1 })]); // old
  await store.flushTraffic(new Date("2026-07-04T10:00:00Z"), [tr("a", { requests: 2 })]); // in window
  await store.flushTraffic(new Date("2026-07-04T10:00:00Z"), [tr("b", { requests: 9 })]); // other site
  const rows = await store.trafficSeries("a", new Date("2026-07-04T09:30:00Z"));
  expect(rows.map((r) => r.requests)).toEqual([2]);
  await db.destroy();
});

test("latestTrafficPerSite: newest minute per site within the window", async () => {
  const db = await makeTestDb();
  const store = new MetricsStore(db);
  await store.flushTraffic(new Date("2026-07-04T10:00:00Z"), [tr("a", { requests: 1 })]);
  await store.flushTraffic(new Date("2026-07-04T10:01:00Z"), [tr("a", { requests: 2 })]); // newest for a
  await store.flushTraffic(new Date("2026-07-04T10:00:00Z"), [tr("b", { requests: 5 })]);
  const rows = (await store.latestTrafficPerSite(new Date("2026-07-04T09:00:00Z"))).sort((x, y) => x.siteName.localeCompare(y.siteName));
  expect(rows.map((r) => [r.siteName, r.requests])).toEqual([
    ["a", 2],
    ["b", 5],
  ]);
  await db.destroy();
});

test("sweepTraffic: deletes rows older than the cutoff, returns the count", async () => {
  const db = await makeTestDb();
  const store = new MetricsStore(db);
  await store.flushTraffic(new Date("2026-06-01T00:00:00Z"), [tr("a", { requests: 1 })]); // ancient
  await store.flushTraffic(new Date("2026-07-04T10:00:00Z"), [tr("a", { requests: 2 })]); // fresh
  const removed = await store.sweepTraffic(new Date("2026-07-01T00:00:00Z"));
  expect(removed).toBe(1);
  const rows = await store.trafficSeries("a", new Date(0));
  expect(rows.map((r) => r.requests)).toEqual([2]);
  await db.destroy();
});

test("recordUptime: last-write-wins on the minute bucket", async () => {
  const db = await makeTestDb();
  await seedSite(db, "a");
  const store = new MetricsStore(db);
  await store.recordUptime("a", MIN, { ok: true, latencyMs: 50, status: 200 });
  await store.recordUptime("a", MIN, { ok: false, latencyMs: 0, status: 502 });
  const rows = await store.uptimeSince("a", new Date(0));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ minute: MIN.toISOString(), ok: false, latencyMs: 0, status: 502 });
  await db.destroy();
});

test("sweepUptime: deletes uptime rows older than the cutoff", async () => {
  const db = await makeTestDb();
  await seedSite(db, "a");
  const store = new MetricsStore(db);
  await store.recordUptime("a", new Date("2026-06-01T00:00:00Z"), { ok: true, latencyMs: 1, status: 200 });
  await store.recordUptime("a", new Date("2026-07-04T10:00:00Z"), { ok: true, latencyMs: 2, status: 200 });
  expect(await store.sweepUptime(new Date("2026-07-01T00:00:00Z"))).toBe(1);
  expect(await store.uptimeSince("a", new Date(0))).toHaveLength(1);
  await db.destroy();
});
