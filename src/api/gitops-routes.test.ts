// (B3) GitOps link routes — link/status/unlink/sync/apply over the REAL reconcileStack (FakeKube), with
// the raw-file fetch injected via Deps.gitopsFetch (no network). Standalone harness (a small mirror of
// environments.test.ts's `mk`/`call`) so this suite never races the concurrently-edited server.test.ts.
// Covers: link authz (create-tier; viewer 403; non-member 404) + token-to-row + never-returns-token;
// status; sync-now (changed → resources reconciled + state + audit + events; unchanged → no-op; fetch
// failure → last_error + gitops_failed; dir: spec → refused); dry-run-only parking + the reviewed apply
// (+ the moved-since-review 409); unlink.
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
import { StackStore } from "../stacks/store.ts";
import { StackLinkStore } from "../gitops/store.ts";
import { contentSha } from "../gitops/fetch.ts";
import type { GitopsSyncRunner } from "../gitops/sync.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { AuditStore } from "../audit/store.ts";
import { EventStore } from "../events/store.ts";
import { makeTestDb } from "../db/testdb.ts";
import { FakeVerifier } from "../auth/oidc.ts";
import { loadConfig } from "../config.ts";

const YAML_V1 = ["stack:", "  name: shop", "  resources:", "    db:", "      type: database", "      storage: 1Gi", "    api:", "      type: app", "      image: ghcr.io/acme/api:1", "      uses:", "        - database: db", ""].join("\n");
const YAML_V2 = YAML_V1.replace("api:1", "api:2");
const YAML_DIR = ["stack:", "  name: shop", "  resources:", "    web:", "      type: site", "      dir: ./web", ""].join("\n");

async function mk() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const blob = new FakeBlob();
  const kube = new FakeKube();
  const secrets = new FakeSecretStore();
  const meta = new MetaStore(db);
  const cfg = loadConfig({
    DROP_S3_BUCKET: "b",
    DROP_DATABASE_URL: "postgres://x/y",
    DROP_BASE_DOMAIN: "drop.example.com",
    DROP_S3_ENDPOINT: "http://localhost:4566",
  });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@example.com", email: "alice@example.com" },
    bob: { sub: "bob@example.com", email: "bob@example.com" },
  });
  const orgs = new OrgStore(db);
  const images = new FakeImageStore();
  const audit = new AuditStore(db);
  const locks = new LockStore(db);
  const bucket = new FakeBucketStore();
  const quotas = new QuotaStore(db);
  const events = new EventStore(db, { deliver: async () => {} });
  const gitopsLinks = new StackLinkStore(db);
  // The scriptable raw-file transport — tests point it at the "current file contents".
  let file: { body: string; status: number } = { body: YAML_V1, status: 200 };
  const fetchCalls: { url: string; headers: Record<string, string> }[] = [];
  const gitopsFetch = async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    return new Response(file.body, { status: file.status });
  };
  let poller: GitopsSyncRunner | undefined;
  const app = createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit, locks, bucket, quotas, events, gitopsLinks, gitopsFetch, onGitopsSync: (run) => (poller = run) });
  return { app, meta, orgs, audit, events, db, users, gitopsLinks, fetchCalls, stacks: new StackStore(db), setFile: (body: string, status = 200) => (file = { body, status }), poller: () => poller! };
}

const call = (app: any, method: string, path: string, tok: string, body?: any) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
const json = async (r: Response) => await (r as any).json();

const baseStack = {
  name: "shop",
  resources: {
    db: { type: "database", storage: "1Gi" },
    api: { type: "app", image: "ghcr.io/acme/api:1", uses: [{ database: "db" }] },
  },
};

/** Bootstrap the stack (default env) as alice, then link it. */
async function bootstrap(h: Awaited<ReturnType<typeof mk>>, linkBody: Record<string, unknown> = {}) {
  expect((await call(h.app, "POST", "/v1/stacks/shop/up", "alice", { spec: baseStack })).status).toBe(200);
  const res = await call(h.app, "POST", "/v1/stacks/shop/link", "alice", { repo: "https://github.com/acme/shop", token: "ghp_sekret", ...linkBody });
  expect(res.status).toBe(200);
  return json(res);
}

test("B3 routes: link stores the token WRITE-ONLY (row has it; no response ever returns it), defaults branch/path, audited", async () => {
  const h = await mk();
  const linked = await bootstrap(h);
  expect(linked.link.repo).toBe("https://github.com/acme/shop");
  expect(linked.link.branch).toBe("main");
  expect(linked.link.path).toBe("drop.yaml");
  expect(linked.link.hasToken).toBe(true);
  expect(JSON.stringify(linked)).not.toContain("ghp_sekret"); // masked in the create response

  // the row carries it (the poller's auth header source)…
  const stack = (await h.stacks.getByName((await h.orgs.ensurePersonalOrg("alice@example.com")).id, "shop"))!;
  expect((await h.gitopsLinks.get(stack.id))!.token).toBe("ghp_sekret");

  // …and the status GET masks it too
  const status = await json(await call(h.app, "GET", "/v1/stacks/shop/link", "alice"));
  expect(status.link.hasToken).toBe(true);
  expect(JSON.stringify(status)).not.toContain("ghp_sekret");

  // audited without the token
  const trail = await h.audit.list({ action: "stack.link" });
  expect(trail.entries).toHaveLength(1);
  expect(trail.entries[0]!.detail!.hasToken).toBe(true);
  expect(JSON.stringify(trail.entries[0])).not.toContain("ghp_sekret");
  await h.db.destroy();
});

test("B3 routes: link input validation (repo required; branch/path shapes) → clean 400s", async () => {
  const h = await mk();
  expect((await call(h.app, "POST", "/v1/stacks/shop/up", "alice", { spec: baseStack })).status).toBe(200);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link", "alice", {})).status).toBe(400);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link", "alice", { repo: "https://github.com/a/b", branch: "bad branch" })).status).toBe(400);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link", "alice", { repo: "https://github.com/a/b", path: "../etc/passwd" })).status).toBe(400);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link", "alice", { repo: "https://github.com/a/b", path: "/abs.yaml" })).status).toBe(400);
  await h.db.destroy();
});

test("B3 routes: authz — viewers can READ the status but not manage/sync; non-members see nothing", async () => {
  const h = await mk();
  await bootstrap(h);
  // bob is nobody → findStack 404s (no leak that the stack exists)
  expect((await call(h.app, "GET", "/v1/stacks/shop/link", "bob")).status).toBe(404);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link", "bob", { repo: "https://github.com/x/y" })).status).toBe(404);

  // bob as a VIEWER: status ok (org membership), manage/sync/apply/unlink all 403 (create-tier)
  await h.users.upsertOnLogin("bob@example.com", null);
  const org = await h.orgs.ensurePersonalOrg("alice@example.com");
  await h.orgs.addMember(org.id, "bob@example.com", "viewer");
  expect((await call(h.app, "GET", "/v1/stacks/shop/link", "bob")).status).toBe(200);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link", "bob", { repo: "https://github.com/x/y" })).status).toBe(403);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link/sync", "bob", {})).status).toBe(403);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link/apply", "bob", {})).status).toBe(403);
  expect((await call(h.app, "DELETE", "/v1/stacks/shop/link", "bob")).status).toBe(403);
  await h.db.destroy();
});

test("B3 routes: sync-now — changed content reconciles the stack (real reconcileStack), updates state, audits stack.sync, emits gitops_synced; unchanged → no-op", async () => {
  const h = await mk();
  await bootstrap(h);
  h.setFile(YAML_V2); // image bump vs the applied spec

  const r1 = await json(await call(h.app, "POST", "/v1/stacks/shop/link/sync", "alice", {}));
  expect(r1.result.outcome).toBe("synced");
  expect(r1.result.sha).toBe(contentSha(YAML_V2));
  expect(r1.link.lastStatus).toBe("synced");
  expect(r1.link.lastSha).toBe(contentSha(YAML_V2));
  expect(r1.link.lastError).toBeNull();
  expect(JSON.stringify(r1)).not.toContain("ghp_sekret");

  // the fetch carried the token as the GitHub auth header (and hit the raw URL)
  const last = h.fetchCalls.at(-1)!;
  expect(last.url).toBe("https://raw.githubusercontent.com/acme/shop/main/drop.yaml");
  expect(last.headers.authorization).toBe("Bearer ghp_sekret");

  // the REAL reconcile ran: resources exist and the spec advanced to the fetched image
  expect((await h.meta.getSitePlain("shop-db"))!.type).toBe("database");
  expect((await h.meta.getSitePlain("shop-api"))!.type).toBe("app");
  const org = await h.orgs.ensurePersonalOrg("alice@example.com");
  const stack = (await h.stacks.getByName(org.id, "shop"))!;
  expect(stack.spec.resources.api!.image).toBe("ghcr.io/acme/api:2");

  // audited as stack.sync (by reconcileStack — actor = the link creator), with the gitops provenance
  const trail = await h.audit.list({ action: "stack.sync" });
  expect(trail.entries).toHaveLength(1);
  expect(trail.entries[0]!.actor).toBe("alice@example.com");
  expect(trail.entries[0]!.detail!.gitops).toBe(true);
  expect(trail.entries[0]!.detail!.sha).toBe(contentSha(YAML_V2));

  // gitops_synced landed in the G3 feed
  const feed = await h.events.list(org.id);
  expect(feed.events.map((e) => e.kind)).toContain("gitops_synced");

  // same content again → unchanged, no second reconcile/audit
  const r2 = await json(await call(h.app, "POST", "/v1/stacks/shop/link/sync", "alice", {}));
  expect(r2.result.outcome).toBe("unchanged");
  expect((await h.audit.list({ action: "stack.sync" })).entries).toHaveLength(1);
  await h.db.destroy();
});

test("B3 routes: sync failure paths — fetch 500 records last_error + gitops_failed; a dir: spec is refused (spec-only v1); recovery resolves the incident", async () => {
  const h = await mk();
  await bootstrap(h);

  h.setFile("boom", 500);
  const r1 = await json(await call(h.app, "POST", "/v1/stacks/shop/link/sync", "alice", {}));
  expect(r1.result.outcome).toBe("failed");
  expect(r1.link.lastStatus).toBe("failed");
  expect(r1.link.lastError).toMatch(/fetch returned 500/);
  const org = await h.orgs.ensurePersonalOrg("alice@example.com");
  let feed = await h.events.list(org.id);
  const failed = feed.events.find((e) => e.kind === "gitops_failed");
  expect(failed).toBeDefined();
  expect(failed!.severity).toBe("error");
  expect(failed!.resolvedAt).toBeNull();

  h.setFile(YAML_DIR);
  const r2 = await json(await call(h.app, "POST", "/v1/stacks/shop/link/sync", "alice", {}));
  expect(r2.result.outcome).toBe("failed");
  expect(r2.link.lastError).toMatch(/spec-only GitOps v1.*dir:/);

  // a good sync closes the open gitops_failed incident
  h.setFile(YAML_V2);
  const r3 = await json(await call(h.app, "POST", "/v1/stacks/shop/link/sync", "alice", {}));
  expect(r3.result.outcome).toBe("synced");
  feed = await h.events.list(org.id);
  expect(feed.events.find((e) => e.kind === "gitops_failed")!.resolvedAt).not.toBeNull();
  await h.db.destroy();
});

test("B3 routes: dry-run-only — a change parks as pending_review (NOT applied); apply executes it; a moved file 409s and re-parks", async () => {
  const h = await mk();
  await bootstrap(h, { dryRunOnly: true });
  h.setFile(YAML_V2);

  // parked, not applied
  const r1 = await json(await call(h.app, "POST", "/v1/stacks/shop/link/sync", "alice", {}));
  expect(r1.result.outcome).toBe("pending_review");
  expect(r1.link.lastStatus).toBe("pending_review");
  expect(r1.link.pendingSha).toBe(contentSha(YAML_V2));
  const org = await h.orgs.ensurePersonalOrg("alice@example.com");
  let stack = (await h.stacks.getByName(org.id, "shop"))!;
  expect(stack.spec.resources.api!.image).toBe("ghcr.io/acme/api:1"); // untouched

  // the reviewed apply runs it
  const r2 = await json(await call(h.app, "POST", "/v1/stacks/shop/link/apply", "alice", {}));
  expect(r2.result.outcome).toBe("synced");
  expect(r2.link.lastStatus).toBe("synced");
  expect(r2.link.lastSha).toBe(contentSha(YAML_V2));
  expect(r2.link.pendingSha).toBeNull();
  stack = (await h.stacks.getByName(org.id, "shop"))!;
  expect(stack.spec.resources.api!.image).toBe("ghcr.io/acme/api:2");

  // nothing pending anymore → apply 409s
  expect((await call(h.app, "POST", "/v1/stacks/shop/link/apply", "alice", {})).status).toBe(409);

  // park a new change, then move the file BEFORE the apply → 409 + re-parked under the new sha
  h.setFile(YAML_V2.replace("api:2", "api:3"));
  expect((await json(await call(h.app, "POST", "/v1/stacks/shop/link/sync", "alice", {}))).result.outcome).toBe("pending_review");
  h.setFile(YAML_V2.replace("api:2", "api:4"));
  const moved = await call(h.app, "POST", "/v1/stacks/shop/link/apply", "alice", {});
  expect(moved.status).toBe(409);
  const movedBody = await json(moved);
  expect(movedBody.result.changedSinceReview).toBe(true);
  expect(movedBody.link.pendingSha).toBe(contentSha(YAML_V2.replace("api:2", "api:4")));
  stack = (await h.stacks.getByName(org.id, "shop"))!;
  expect(stack.spec.resources.api!.image).toBe("ghcr.io/acme/api:2"); // still the reviewed-and-applied one
  await h.db.destroy();
});

test("B3 routes: the poller runner handed over via onGitopsSync is the SAME code path (poll → apply state)", async () => {
  const h = await mk();
  await bootstrap(h);
  h.setFile(YAML_V2);
  const org = await h.orgs.ensurePersonalOrg("alice@example.com");
  const stack = (await h.stacks.getByName(org.id, "shop"))!;
  const link = (await h.gitopsLinks.get(stack.id))!;
  const r = await h.poller()(stack, link); // what a bin/api.ts poll tick runs
  expect(r.outcome).toBe("synced");
  expect((await h.gitopsLinks.get(stack.id))!.lastSha).toBe(contentSha(YAML_V2));
  expect((await h.stacks.getByName(org.id, "shop"))!.spec.resources.api!.image).toBe("ghcr.io/acme/api:2");
  await h.db.destroy();
});

test("B3 routes: unlink removes the link (audited); status shows null; sync on an unlinked stack 404s", async () => {
  const h = await mk();
  await bootstrap(h);
  expect((await call(h.app, "DELETE", "/v1/stacks/shop/link", "alice")).status).toBe(200);
  expect((await json(await call(h.app, "GET", "/v1/stacks/shop/link", "alice"))).link).toBeNull();
  expect((await call(h.app, "DELETE", "/v1/stacks/shop/link", "alice")).status).toBe(404);
  expect((await call(h.app, "POST", "/v1/stacks/shop/link/sync", "alice", {})).status).toBe(404);
  const trail = await h.audit.list({ action: "stack.unlink" });
  expect(trail.entries).toHaveLength(1);
  expect(trail.entries[0]!.target).toBe("shop");
  await h.db.destroy();
});
