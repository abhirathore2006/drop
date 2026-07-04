import { test, expect } from "bun:test";
import { EventStore, type EventRecord } from "./store.ts";
import { makeTestDb } from "../db/testdb.ts";
import { OrgStore } from "../orgs/store.ts";
import type { Db } from "../db/db.ts";

// Seed a user + a team org owned by them (satisfies the events.org_id FK + org_members for badge counts).
async function seedOrg(db: Db, slug: string, email: string): Promise<string> {
  await db.insertInto("users").values({ email, name: null, role: "member", status: "active" }).onConflict((oc) => oc.doNothing()).execute();
  const org = await new OrgStore(db).createOrg(slug, slug, email);
  return org.id;
}

test("emit dedups to one open incident and bumps count + created_at", async () => {
  const db = await makeTestDb();
  const org = await seedOrg(db, "acme", "a@x.com");
  let t = 1_000;
  const store = new EventStore(db, { now: () => new Date(t) });

  const first = await store.emit({ orgId: org, siteName: "api", kind: "crashloop", severity: "error", title: "crash-loop: api", detail: { restarts: 3 } });
  expect(first.detail).toEqual({ restarts: 3, count: 1 });

  t = 5_000;
  const second = await store.emit({ orgId: org, siteName: "api", kind: "crashloop", severity: "error", title: "crash-loop: api", detail: { restarts: 7 } });
  expect(second.id).toBe(first.id); // SAME open row — deduped
  expect(second.detail).toEqual({ restarts: 7, count: 2 }); // count bumped, detail merged
  expect(second.createdAt).toBe(new Date(5_000).toISOString()); // created_at freshened

  const { events } = await store.list(org);
  expect(events.length).toBe(1); // still ONE row
  await db.destroy();
});

test("resolve closes the open incident; a later emit opens a fresh one", async () => {
  const db = await makeTestDb();
  const org = await seedOrg(db, "acme", "a@x.com");
  const store = new EventStore(db, { now: () => new Date(2_000) });

  const open = await store.emit({ orgId: org, siteName: "api", kind: "crashloop", severity: "error", title: "crash-loop: api" });
  const resolved = await store.resolve("api", "crashloop");
  expect(resolved!.id).toBe(open.id);
  expect(resolved!.resolvedAt).not.toBeNull();

  // resolve again → no open row → null (no-op)
  expect(await store.resolve("api", "crashloop")).toBeNull();

  // a fresh emit after resolve opens a NEW incident (not the resolved one)
  const reopened = await store.emit({ orgId: org, siteName: "api", kind: "crashloop", severity: "error", title: "crash-loop: api" });
  expect(reopened.id).not.toBe(open.id);
  expect(reopened.detail).toEqual({ count: 1 });

  const { events } = await store.list(org);
  expect(events.length).toBe(2); // one resolved + one fresh open
  await db.destroy();
});

test("dedup is scoped per (org, site, kind); different kinds/sites are distinct incidents", async () => {
  const db = await makeTestDb();
  const org = await seedOrg(db, "acme", "a@x.com");
  const store = new EventStore(db, { now: () => new Date() });
  await store.emit({ orgId: org, siteName: "api", kind: "crashloop", severity: "error", title: "x" });
  await store.emit({ orgId: org, siteName: "api", kind: "deploy_failed", severity: "error", title: "y" }); // diff kind
  await store.emit({ orgId: org, siteName: "web", kind: "crashloop", severity: "error", title: "z" }); // diff site
  await store.emit({ orgId: org, kind: "quota", severity: "warning", title: "q" }); // null site (org-level)
  const { events } = await store.list(org);
  expect(events.length).toBe(4);
  await db.destroy();
});

test("keyset pagination via nextCursor, newest-first, org-scoped", async () => {
  const db = await makeTestDb();
  const org = await seedOrg(db, "acme", "a@x.com");
  const other = await seedOrg(db, "beta", "b@x.com");
  const store = new EventStore(db, { now: () => new Date() });
  for (let i = 0; i < 5; i++) await store.emit({ orgId: org, siteName: `s${i}`, kind: "deploy_failed", severity: "error", title: `t${i}` });
  await store.emit({ orgId: other, siteName: "z", kind: "deploy_failed", severity: "error", title: "other-org" }); // must not leak

  const p1 = await store.list(org, { limit: 2 });
  expect(p1.events.length).toBe(2);
  expect(p1.nextCursor).toBeDefined();
  const p2 = await store.list(org, { limit: 2, cursor: p1.nextCursor });
  expect(p2.events.length).toBe(2);
  expect(Number(p2.events[0]!.id)).toBeLessThan(Number(p1.events[1]!.id)); // disjoint + older
  // no event from the other org leaked in
  const all = await store.list(org, { limit: 100 });
  expect(all.events.every((e) => e.title !== "other-org")).toBe(true);
  await db.destroy();
});

test("badge counts open warning/error incidents for the user's orgs; info + resolved excluded", async () => {
  const db = await makeTestDb();
  const org = await seedOrg(db, "acme", "a@x.com");
  const store = new EventStore(db, { now: () => new Date() });
  await store.emit({ orgId: org, siteName: "api", kind: "crashloop", severity: "error", title: "e" }); // counts
  await store.emit({ orgId: org, kind: "quota", severity: "warning", title: "w" }); // counts
  await store.emit({ orgId: org, siteName: "api", kind: "preview_expiring", severity: "info", title: "i" }); // info → NOT counted
  const resolvedSite = await store.emit({ orgId: org, siteName: "web", kind: "deploy_failed", severity: "error", title: "r" });
  await store.resolve("web", "deploy_failed");
  void resolvedSite;

  expect(await store.countUnresolved(org)).toBe(2); // error + warning open (info + resolved excluded)
  expect(await store.countUnresolvedForUser("a@x.com")).toBe(2);
  expect(await store.countUnresolvedForUser("nobody@x.com")).toBe(0); // not a member of any org
  await db.destroy();
});

test("webhook get/set/delete round-trip; delivery fires ONLY on a state transition (new open + resolve)", async () => {
  const db = await makeTestDb();
  const org = await seedOrg(db, "acme", "a@x.com");
  const delivered: { url: string; secret: string | null; event: EventRecord }[] = [];
  const store = new EventStore(db, {
    now: () => new Date(),
    deliver: async (target, event) => {
      delivered.push({ url: target.url, secret: target.secret, event });
    },
  });

  // no webhook set → no delivery
  await store.emit({ orgId: org, siteName: "api", kind: "crashloop", severity: "error", title: "x" });
  expect(delivered.length).toBe(0);

  await store.setWebhook(org, "https://hooks.example.com/abc", "s3cr3t", "a@x.com");
  const wh = await store.getWebhook(org);
  expect(wh).toEqual({ url: "https://hooks.example.com/abc", secret: "s3cr3t", updatedBy: "a@x.com", updatedAt: wh!.updatedAt });

  // a NEW open incident delivers once; a dedup bump does NOT
  await store.emit({ orgId: org, siteName: "web", kind: "crashloop", severity: "error", title: "new" });
  expect(delivered.length).toBe(1);
  expect(delivered[0]!.url).toBe("https://hooks.example.com/abc");
  expect(delivered[0]!.secret).toBe("s3cr3t");
  await store.emit({ orgId: org, siteName: "web", kind: "crashloop", severity: "error", title: "bump" });
  expect(delivered.length).toBe(1); // still 1 — the bump did not re-deliver

  // a resolve is a state transition → delivers
  await store.resolve("web", "crashloop");
  expect(delivered.length).toBe(2);
  expect(delivered[1]!.event.resolvedAt).not.toBeNull();

  await store.setWebhook(org, "https://hooks.example.com/new", null, "a@x.com"); // replace, drop secret
  expect((await store.getWebhook(org))!.secret).toBeNull();
  await store.deleteWebhook(org);
  expect(await store.getWebhook(org)).toBeNull();
  await db.destroy();
});

test("sweep deletes events older than the cutoff", async () => {
  const db = await makeTestDb();
  const org = await seedOrg(db, "acme", "a@x.com");
  let t = new Date("2026-01-01T00:00:00Z").getTime();
  const store = new EventStore(db, { now: () => new Date(t) });
  await store.emit({ orgId: org, siteName: "old", kind: "deploy_failed", severity: "error", title: "old" });
  t = new Date("2026-02-01T00:00:00Z").getTime();
  await store.emit({ orgId: org, siteName: "new", kind: "deploy_failed", severity: "error", title: "new" });
  const removed = await store.sweep(new Date("2026-01-15T00:00:00Z"));
  expect(removed).toBe(1);
  const { events } = await store.list(org);
  expect(events.map((e) => e.siteName)).toEqual(["new"]);
  await db.destroy();
});
