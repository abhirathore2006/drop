import { test, expect } from "bun:test";
import { createApp } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
import { FakeKube } from "../kube/fake.ts";
import { FakeSecretStore } from "../secrets/fake.ts";
import { FakeImageStore } from "../images/fake.ts";
import { FakeBucketStore } from "../buckets/fake.ts";
import { QuotaStore } from "../quotas/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { LockStore } from "../metastore/lock.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { AuditStore } from "../audit/store.ts";
import { EventStore, type EventRecord } from "../events/store.ts";
import { makeTestDb } from "../db/testdb.ts";
import { FakeVerifier } from "../auth/oidc.ts";
import { loadConfig } from "../config.ts";

// Harness with an INJECTED EventStore whose delivery is captured (no network) so we can assert webhook
// delivery + emits without touching the shared server.test.ts mk().
async function mk(env: Record<string, string> = {}) {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const meta = new MetaStore(db);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com", DROP_S3_ENDPOINT: "http://localhost:4566", ...env });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@example.com", email: "alice@example.com" },
    bob: { sub: "bob@example.com", email: "bob@example.com" },
  });
  const orgs = new OrgStore(db);
  const kube = new FakeKube();
  const deliveries: { url: string; secret: string | null; event: EventRecord }[] = [];
  const events = new EventStore(db, { deliver: async (t, e) => void deliveries.push({ url: t.url, secret: t.secret, event: e }) });
  const app = createApp({
    cfg, meta, blob: new FakeBlob(), db, users, verifier, kube,
    secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs,
    audit: new AuditStore(db), locks: new LockStore(db), bucket: new FakeBucketStore(), quotas: new QuotaStore(db), events,
  });
  return { app, meta, orgs, events, deliveries, audit: new AuditStore(db), db, kube };
}

const call = (app: any, method: string, path: string, tok: string, body?: any) =>
  app.request(path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

test("GET /v1/orgs/:slug/events — member sees the org feed; non-member 403; other-org events don't leak", async () => {
  const { app, orgs, events } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" }); // alice = owner
  const acme = (await orgs.getOrgBySlug("acme"))!;
  await events.emit({ orgId: acme.id, siteName: "api", kind: "crashloop", severity: "error", title: "crash-loop: api" });

  // non-member (bob) → 403
  expect((await call(app, "GET", "/v1/orgs/acme/events", "bob")).status).toBe(403);

  // member (alice) → 200 with the feed shape
  const res = await call(app, "GET", "/v1/orgs/acme/events", "alice");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events.length).toBe(1);
  expect(body.events[0]).toMatchObject({ kind: "crashloop", severity: "error", siteName: "api", resolvedAt: null });

  // unresolved count endpoint
  const cnt = await (await call(app, "GET", "/v1/orgs/acme/events?unresolved=1", "alice")).json();
  expect(cnt).toEqual({ count: 1 });
  expect((await call(app, "GET", "/v1/orgs/nope/events", "alice")).status).toBe(404);
});

test("webhook set/get/rm: owner-gated, audited, secret masked; delivery uses the stored config", async () => {
  const { app, orgs, events, deliveries, audit } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  const acme = (await orgs.getOrgBySlug("acme"))!;
  await call(app, "POST", "/v1/orgs/acme/members", "alice", { email: "bob@example.com", role: "viewer" }); // bob is a viewer, not admin

  // a non-owner/admin member can't set the webhook
  expect((await call(app, "POST", "/v1/orgs/acme/webhook", "bob", { url: "https://hooks.slack.com/x" })).status).toBe(403);
  // a bad URL is rejected
  expect((await call(app, "POST", "/v1/orgs/acme/webhook", "alice", { url: "not-a-url" })).status).toBe(400);

  // owner sets it (with a signing secret)
  const set = await call(app, "POST", "/v1/orgs/acme/webhook", "alice", { url: "https://hooks.slack.com/services/T/B/X", secret: "sh" });
  expect(set.status).toBe(200);

  // GET masks the secret
  const got = await (await call(app, "GET", "/v1/orgs/acme/webhook", "alice")).json();
  expect(got.webhook).toMatchObject({ url: "https://hooks.slack.com/services/T/B/X", hasSecret: true, updatedBy: "alice@example.com" });
  expect(JSON.stringify(got)).not.toContain("\"sh\""); // the raw secret is never returned

  // the set was audited
  const trail = await audit.list({ action: "org.webhook.set" });
  expect(trail.entries.length).toBe(1);
  expect(trail.entries[0]).toMatchObject({ target: "acme", actor: "alice@example.com" });

  // a fresh emit now delivers using the stored config (secret carried through)
  await events.emit({ orgId: acme.id, siteName: "api", kind: "crashloop", severity: "error", title: "x" });
  await events.flushDeliveries();
  expect(deliveries.length).toBe(1);
  expect(deliveries[0]).toMatchObject({ url: "https://hooks.slack.com/services/T/B/X", secret: "sh" });

  // owner removes it (audited); GET now null
  expect((await call(app, "DELETE", "/v1/orgs/acme/webhook", "alice")).status).toBe(200);
  expect((await (await call(app, "GET", "/v1/orgs/acme/webhook", "alice")).json()).webhook).toBeNull();
  expect((await audit.list({ action: "org.webhook.remove" })).entries.length).toBe(1);
});

test("a failing release deploy emits a deploy_failed event (asserted via the store)", async () => {
  const { app, meta, events, kube } = await mk();
  kube.scriptedReleases = [{ ok: false, reason: "failed", logs: "migration aborted" }];
  const res = await call(app, "POST", "/v1/apps/migrapp", "alice", { image: "todo:1", release: "npm run migrate" });
  expect(res.status).toBe(422);
  const org = (await meta.getSitePlain("migrapp"))!.orgId!;
  const { events: rows } = await events.list(org);
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ kind: "deploy_failed", severity: "error", siteName: "migrapp" });
  expect(rows[0]!.detail).toMatchObject({ reason: "failed" });

  // a subsequent SUCCESSFUL deploy resolves it (recovery)
  const ok = await call(app, "POST", "/v1/apps/migrapp", "alice", { image: "todo:2" });
  expect(ok.status).toBe(200);
  const after = await events.list(org);
  expect(after.events[0]!.resolvedAt).not.toBeNull(); // the open incident is now closed
});

test("quota-429 on the workload cap emits ONE throttled quota event (dedup)", async () => {
  const { app, meta, events } = await mk({ DROP_MAX_WORKLOADS_PER_ORG: "1" });
  // first app claims the single slot
  expect((await call(app, "POST", "/v1/apps/one", "alice", { image: "x:1" })).status).toBe(200);
  const org = (await meta.getSitePlain("one"))!.orgId!;
  // second + third creates are over the cap → 429 each, but the quota event dedups to ONE open row
  expect((await call(app, "POST", "/v1/apps/two", "alice", { image: "x:1" })).status).toBe(429);
  expect((await call(app, "POST", "/v1/apps/three", "alice", { image: "x:1" })).status).toBe(429);
  const { events: rows } = await events.list(org);
  const quota = rows.filter((r) => r.kind === "quota");
  expect(quota.length).toBe(1); // throttled
  expect(quota[0]!.detail).toMatchObject({ count: 2, reason: "workloads" }); // two rejections collapsed onto one incident
});

test("/v1/me folds in the unresolved (warning/error) badge count across the caller's orgs", async () => {
  const { app, orgs, events } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  const acme = (await orgs.getOrgBySlug("acme"))!;
  // ensure alice's personal org exists too (touch /v1/me once)
  await call(app, "GET", "/v1/me", "alice");
  await events.emit({ orgId: acme.id, siteName: "api", kind: "crashloop", severity: "error", title: "x" }); // counts
  await events.emit({ orgId: acme.id, siteName: "api", kind: "preview_expiring", severity: "info", title: "i" }); // info → not counted

  const me = await (await call(app, "GET", "/v1/me", "alice")).json();
  expect(me.unresolvedEvents).toBe(1);
  // bob (not a member of acme) sees zero
  const bob = await (await call(app, "GET", "/v1/me", "bob")).json();
  expect(bob.unresolvedEvents).toBe(0);
});
