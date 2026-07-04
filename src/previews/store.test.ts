import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { PreviewStore, validatePreviewLabel } from "./store.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@x.com");
  const meta = new MetaStore(db);
  await meta.claimSite("myapp", "alice@x.com", "site", { id: org.id, namespace: org.namespace });
  return { db };
}

test("validatePreviewLabel: dns-safe, 1-20 chars, no '--'", () => {
  expect(validatePreviewLabel("pr-42")).toBeNull();
  expect(validatePreviewLabel("a")).toBeNull();
  expect(validatePreviewLabel("a".repeat(20))).toBeNull();
  expect(validatePreviewLabel("a".repeat(21))).not.toBeNull();
  expect(validatePreviewLabel("")).not.toBeNull();
  expect(validatePreviewLabel("-abc")).not.toBeNull();
  expect(validatePreviewLabel("abc-")).not.toBeNull();
  expect(validatePreviewLabel("Abc")).not.toBeNull();
  expect(validatePreviewLabel("pr--42")).toMatch(/reserved/);
});

test("upsert creates, then re-points the SAME label at a new version (no duplicate row)", async () => {
  const { db } = await fix();
  const store = new PreviewStore(db);
  const p1 = await store.upsert("myapp", "pr-1", "v1", "alice@x.com", new Date("2026-02-01T00:00:00Z"));
  expect(p1.versionId).toBe("v1");
  const p2 = await store.upsert("myapp", "pr-1", "v2", "alice@x.com", new Date("2026-02-05T00:00:00Z"));
  expect(p2.versionId).toBe("v2");
  const rows = await store.listForSite("myapp");
  expect(rows).toHaveLength(1); // re-point, not a second row
  expect(rows[0]!.versionId).toBe("v2");
  expect(rows[0]!.expiresAt).toBe(new Date("2026-02-05T00:00:00Z").toISOString());
  await db.destroy();
});

test("get resolves a label; unknown label is null", async () => {
  const { db } = await fix();
  const store = new PreviewStore(db);
  await store.upsert("myapp", "pr-1", "v1", "alice@x.com", new Date("2026-02-01T00:00:00Z"));
  expect((await store.get("myapp", "pr-1"))!.versionId).toBe("v1");
  expect(await store.get("myapp", "nope")).toBeNull();
  await db.destroy();
});

test("listForSite is newest-first and scoped to the site", async () => {
  const { db } = await fix();
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@x.com");
  await meta.claimSite("other", "alice@x.com", "site", { id: org.id, namespace: org.namespace });
  // injectable clock → deterministic created_at ordering (real upserts can share a millisecond)
  let t = new Date("2026-01-10T00:00:00Z");
  const store = new PreviewStore(db, () => t);
  await store.upsert("myapp", "a", "v1", "alice@x.com", new Date("2026-02-01T00:00:00Z"));
  t = new Date("2026-01-11T00:00:00Z");
  await store.upsert("myapp", "b", "v2", "alice@x.com", new Date("2026-02-02T00:00:00Z"));
  t = new Date("2026-01-12T00:00:00Z");
  await store.upsert("other", "c", "v3", "alice@x.com", new Date("2026-02-03T00:00:00Z"));
  const rows = await store.listForSite("myapp");
  expect(rows.map((r) => r.label)).toEqual(["b", "a"]);
  await db.destroy();
});

test("remove is idempotent (true once, false the second time / for an unknown label)", async () => {
  const { db } = await fix();
  const store = new PreviewStore(db);
  await store.upsert("myapp", "pr-1", "v1", "alice@x.com", new Date("2026-02-01T00:00:00Z"));
  expect(await store.remove("myapp", "pr-1")).toBe(true);
  expect(await store.remove("myapp", "pr-1")).toBe(false);
  expect(await store.remove("myapp", "nope")).toBe(false);
  await db.destroy();
});

test("deleting the site cascades to its previews", async () => {
  const { db } = await fix();
  const meta = new MetaStore(db);
  const store = new PreviewStore(db);
  await store.upsert("myapp", "pr-1", "v1", "alice@x.com", new Date("2026-02-01T00:00:00Z"));
  await meta.deleteSite("myapp");
  expect(await store.get("myapp", "pr-1")).toBeNull();
  await db.destroy();
});

test("deleteExpired (the housekeeping sweep) removes only rows past `now`, returns them, leaves the rest", async () => {
  const { db } = await fix();
  const store = new PreviewStore(db);
  await store.upsert("myapp", "old", "v1", "alice@x.com", new Date("2026-01-01T00:00:00Z")); // already expired
  await store.upsert("myapp", "fresh", "v2", "alice@x.com", new Date("2026-06-01T00:00:00Z")); // not yet
  const removed = await store.deleteExpired(new Date("2026-02-01T00:00:00Z"));
  expect(removed).toEqual([{ siteName: "myapp", label: "old" }]);
  expect(await store.get("myapp", "old")).toBeNull();
  expect(await store.get("myapp", "fresh")).not.toBeNull();
  await db.destroy();
});
