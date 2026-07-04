import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { QuotaStore } from "../quotas/store.ts";
import { FakeBlob } from "../blob/fake.ts";
import { sweepLogRetention } from "./retention.ts";
import { logObjectKey } from "./format.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@x.com");
  const quotas = new QuotaStore(db);
  const blob = new FakeBlob();
  return { db, meta, orgs, quotas, blob, orgId: org.id, ns: org.namespace };
}

/** Register a site + a log object at `hour`, writing a real blob so the sweep has bytes to delete. */
async function putObject(t: Awaited<ReturnType<typeof fix>>, site: string, hour: Date, ensureSite = true) {
  if (ensureSite) await t.meta.claimSite(site, "alice@x.com", "app", { id: t.orgId, namespace: t.ns }).catch(() => {});
  const key = logObjectKey(site, hour);
  const bytes = new Uint8Array([1, 2, 3]);
  await t.blob.put(key, bytes, bytes.byteLength, "application/gzip");
  await t.meta.insertLogObject({ siteName: site, hour, key, lines: 1, bytes: bytes.byteLength });
  return key;
}

test("sweep deletes objects + rows past the default retention; keeps recent ones", async () => {
  const t = await fix();
  const now = new Date("2026-07-10T00:00:00Z");
  const oldKey = await putObject(t, "web", new Date("2026-07-01T00:00:00Z")); // 9d old (past 7d)
  const freshKey = await putObject(t, "web", new Date("2026-07-09T00:00:00Z")); // 1d old (kept)

  const removed = await sweepLogRetention({ meta: t.meta, blob: t.blob, quotas: t.quotas, defaultDays: 7, now: () => now });
  expect(removed).toBe(1);

  expect(await t.blob.get(oldKey)).toBeNull(); // S3 object gone
  expect(await t.blob.get(freshKey)).not.toBeNull(); // recent one kept
  const rows = await t.meta.listLogObjectsInRange("web", new Date("2026-06-01T00:00:00Z"), new Date("2026-07-31T00:00:00Z"));
  expect(rows.map((r) => r.key)).toEqual([freshKey]); // index row for the old object gone too
  await t.db.destroy();
});

test("org override (log_retention_days) widens/narrows the window per org", async () => {
  const t = await fix();
  const now = new Date("2026-07-10T00:00:00Z");
  const key = await putObject(t, "web", new Date("2026-07-05T00:00:00Z")); // 5d old

  // default 7d → kept
  expect(await sweepLogRetention({ meta: t.meta, blob: t.blob, quotas: t.quotas, defaultDays: 7, now: () => now })).toBe(0);
  expect(await t.blob.get(key)).not.toBeNull();

  // override to 3d → now past retention, swept
  await t.quotas.set(t.orgId, "log_retention_days", "3", "alice@x.com");
  expect(await sweepLogRetention({ meta: t.meta, blob: t.blob, quotas: t.quotas, defaultDays: 7, now: () => now })).toBe(1);
  expect(await t.blob.get(key)).toBeNull();
  await t.db.destroy();
});

test("orphan-safe ordering: the S3 object is deleted BEFORE its index row", async () => {
  const t = await fix();
  const now = new Date("2026-07-10T00:00:00Z");
  const key = await putObject(t, "web", new Date("2026-07-01T00:00:00Z"));

  // Plain delegating wrappers that record the delete order — only the methods the sweep calls.
  const order: string[] = [];
  const blob = {
    deletePrefix: async (p: string) => {
      order.push("s3:" + p);
      await t.blob.deletePrefix(p);
    },
  } as unknown as FakeBlob;
  const meta = {
    listLogObjectSites: () => t.meta.listLogObjectSites(),
    listLogObjectsBefore: (s: string, c: Date) => t.meta.listLogObjectsBefore(s, c),
    deleteLogObject: async (site: string, h: Date) => {
      order.push("row:" + site);
      await t.meta.deleteLogObject(site, h);
    },
  } as unknown as MetaStore;

  await sweepLogRetention({ meta, blob, quotas: t.quotas, defaultDays: 7, now: () => now });
  expect(order).toEqual(["s3:" + key, "row:web"]); // object first, then index row
  await t.db.destroy();
});

test("a deleted site's orphaned rows still get swept (default window, no org link)", async () => {
  const t = await fix();
  const now = new Date("2026-07-10T00:00:00Z");
  // insert a log object row for a site name that has NO sites row (as after a site delete)
  const key = await putObject(t, "ghost", new Date("2026-07-01T00:00:00Z"), false);
  const sites = await t.meta.listLogObjectSites();
  expect(sites.find((s) => s.siteName === "ghost")!.orgId).toBeNull(); // no owning org

  const removed = await sweepLogRetention({ meta: t.meta, blob: t.blob, quotas: t.quotas, defaultDays: 7, now: () => now });
  expect(removed).toBe(1);
  expect(await t.blob.get(key)).toBeNull();
  await t.db.destroy();
});
