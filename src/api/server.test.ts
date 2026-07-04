import { test, expect } from "bun:test";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { createApp } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
import { FakeKube } from "../kube/fake.ts";
import { FakeSecretStore } from "../secrets/fake.ts";
import { FakeImageStore } from "../images/fake.ts";
import { FakeBucketStore } from "../buckets/fake.ts";
import { QuotaStore } from "../quotas/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { LockStore } from "../metastore/lock.ts";
import { StackStore, EnvironmentStore } from "../stacks/store.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { AuditStore } from "../audit/store.ts";
import { ServiceTokenStore } from "../tokens/store.ts";
import { makeTestDb } from "../db/testdb.ts";
import { serializeNdjsonGz, logObjectKey, type LogRecord } from "../logs/format.ts";
import { FakeVerifier, ChainVerifier } from "../auth/oidc.ts";
import { TokenVerifier } from "../auth/token-verifier.ts";
import { loadConfig } from "../config.ts";

async function tgz(files: Record<string, string>): Promise<Buffer> {
  const p = pack();
  for (const [n, c] of Object.entries(files)) p.entry({ name: n }, c);
  p.finalize();
  return await buffer(p.pipe(createGzip()));
}

async function mk(opts: { admins?: string[]; env?: Record<string, string>; authEngine?: any; authAdmin?: any; queryExecutor?: any } = {}) {
  const db = await makeTestDb();
  const users = new UserStore(db);
  if (opts.admins) await users.seedAdmins(opts.admins);
  const blob = new FakeBlob();
  const kube = new FakeKube();
  const secrets = new FakeSecretStore();
  const meta = new MetaStore(db);
  // DROP_S3_ENDPOINT set → "local" path for databases (static creds, no IRSA required).
  const cfg = loadConfig({
    DROP_S3_BUCKET: "b",
    DROP_DATABASE_URL: "postgres://x/y",
    DROP_BASE_DOMAIN: "drop.example.com",
    DROP_S3_ENDPOINT: "http://localhost:4566",
    ...opts.env,
  });
  const fake = new FakeVerifier({
    alice: { sub: "alice@example.com", email: "alice@example.com" },
    bob: { sub: "bob@example.com", email: "bob@example.com" },
  });
  const orgs = new OrgStore(db);
  // J1: accept `drop_st_…` service tokens alongside the fake human tokens (TokenVerifier first; it
  // returns null for the non-`drop_st_` alice/bob tokens, so they still resolve via the fake).
  const tokens = new ServiceTokenStore(db);
  const verifier = new ChainVerifier([new TokenVerifier(tokens, orgs), fake]);
  const images = new FakeImageStore();
  const audit = new AuditStore(db);
  const locks = new LockStore(db);
  const bucket = new FakeBucketStore();
  const quotas = new QuotaStore(db);
  return { app: createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit, locks, bucket, quotas, tokens, authEngine: opts.authEngine, authAdmin: opts.authAdmin, queryExecutor: opts.queryExecutor }), meta, blob, kube, secrets, images, orgs, audit, locks, bucket, quotas, tokens, db, users };
}

const pub = (app: any, tok: string, name: string, body: Buffer) =>
  app.request(`/v1/sites/${name}/versions`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/gzip" },
    body,
  });
const call = (app: any, method: string, path: string, tok: string, body?: any) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
const putImage = (app: any, tok: string, name: string, tag: string | null, body: Uint8Array) =>
  app.request(`/v1/apps/${name}/image${tag === null ? "" : `?tag=${encodeURIComponent(tag)}`}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/octet-stream" },
    body,
  });

test("publish claims, sets pointer, returns url", async () => {
  const { app, meta, db } = await mk();
  const res = await pub(app, "alice", "myapp", await tgz({ "index.html": "<html>" }));
  expect(res.status).toBe(200);
  expect((await res.json()).url).toBe("https://myapp.drop.example.com");
  const site = (await meta.getSitePlain("myapp"))!;
  expect(site.owner).toBe("alice@example.com");
  expect(site.currentVersion).not.toBeNull();
  expect(site.visibility).toBe("public");
  await db.destroy();
});

test("publish to a foreign site is 403", async () => {
  const { app, db } = await mk();
  expect((await pub(app, "alice", "shared", await tgz({ "index.html": "x" }))).status).toBe(200);
  expect((await pub(app, "bob", "shared", await tgz({ "index.html": "y" }))).status).toBe(403);
  await db.destroy();
});

test("bad name -> 400", async () => {
  const { app, db } = await mk();
  expect((await pub(app, "alice", "Bad_Name", await tgz({ "index.html": "x" }))).status).toBe(400);
  await db.destroy();
});

test("traversal upload -> 400", async () => {
  const { app, db } = await mk();
  expect((await pub(app, "alice", "evil", await tgz({ "../escape.js": "x" }))).status).toBe(400);
  await db.destroy();
});

test("rollback to previous version", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "v1" }));
  await pub(app, "alice", "myapp", await tgz({ "index.html": "v2" }));
  expect((await call(app, "POST", "/v1/sites/myapp/rollback", "alice", {})).status).toBe(200);
  await db.destroy();
});

test("collaborator lifecycle: editor can publish, cannot share", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  expect((await pub(app, "bob", "myapp", await tgz({ "index.html": "y" }))).status).toBe(403);
  expect((await call(app, "POST", "/v1/sites/myapp/collaborators", "alice", { email: "bob@example.com" })).status).toBe(200);
  expect((await pub(app, "bob", "myapp", await tgz({ "index.html": "y" }))).status).toBe(200);
  expect((await call(app, "POST", "/v1/sites/myapp/collaborators", "bob", { email: "carol@example.com" })).status).toBe(403);
  await db.destroy();
});

test("viewer role can read but not publish", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/sites/myapp/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  expect((await call(app, "GET", "/v1/sites/myapp", "bob")).status).toBe(200); // read ok
  expect((await pub(app, "bob", "myapp", await tgz({ "index.html": "y" }))).status).toBe(403); // publish denied
  await db.destroy();
});

test("get site authz + owner-only delete", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  expect((await call(app, "GET", "/v1/sites/myapp", "alice")).status).toBe(200);
  expect((await call(app, "GET", "/v1/sites/myapp", "bob")).status).toBe(403);
  expect((await call(app, "DELETE", "/v1/sites/myapp", "bob")).status).toBe(403);
  expect((await call(app, "DELETE", "/v1/sites/myapp", "alice")).status).toBe(200);
  await db.destroy();
});

test("transfer ownership moves owner, keeps old as collaborator", async () => {
  const { app, meta, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  expect((await call(app, "POST", "/v1/sites/myapp/transfer", "alice", { email: "bob@example.com" })).status).toBe(200);
  const s = (await meta.getSitePlain("myapp"))!;
  expect(s.owner).toBe("bob@example.com");
  expect(s.collaborators).toContain("alice@example.com");
  // now bob (new owner) can publish, alice (now editor) can still publish but not delete
  expect((await pub(app, "bob", "myapp", await tgz({ "index.html": "y" }))).status).toBe(200);
  expect((await call(app, "DELETE", "/v1/sites/myapp", "alice")).status).toBe(403);
  await db.destroy();
});

test("ls returns only the caller's own + shared sites", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "a-one", await tgz({ "index.html": "x" }));
  await pub(app, "alice", "a-two", await tgz({ "index.html": "x" }));
  await pub(app, "bob", "b-one", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/sites/a-one/collaborators", "alice", { email: "bob@example.com" });

  const alice = await (await call(app, "GET", "/v1/sites", "alice")).json();
  expect(alice.sites.map((s: any) => s.name).sort()).toEqual(["a-one", "a-two"]);
  const bob = await (await call(app, "GET", "/v1/sites", "bob")).json();
  expect(bob.sites.map((s: any) => s.name).sort()).toEqual(["a-one", "b-one"]); // shared a-one shows up
  await db.destroy();
});

test("visibility: set password + private; reflected on get", async () => {
  const { app, meta, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  expect((await call(app, "POST", "/v1/sites/myapp/visibility", "alice", { visibility: "password", password: "s3cr3t" })).status).toBe(200);
  let ptr = (await meta.getPointer("myapp"))!;
  expect(ptr.visibility).toBe("password");
  expect(ptr.passwordHash).toMatch(/^sha256:/);
  expect((await call(app, "POST", "/v1/sites/myapp/visibility", "alice", { visibility: "private" })).status).toBe(200);
  ptr = (await meta.getPointer("myapp"))!;
  expect(ptr.visibility).toBe("private");
  expect(ptr.passwordHash).toBeNull();
  // password visibility requires a password
  expect((await call(app, "POST", "/v1/sites/myapp/visibility", "alice", { visibility: "password" })).status).toBe(400);
  // non-owner cannot configure
  expect((await call(app, "POST", "/v1/sites/myapp/visibility", "bob", { visibility: "public" })).status).toBe(403);
  await db.destroy();
});

test("publishing a bundle with basicAuth sets password visibility", async () => {
  const { app, meta, db } = await mk();
  const tar = await tgz({
    "index.html": "<html>",
    "drop.yaml": 'site:\n  basicAuth:\n    users:\n      admin: "sha256:abc"\n',
  });
  expect((await pub(app, "alice", "secret", tar)).status).toBe(200);
  expect((await meta.getSitePlain("secret"))!.visibility).toBe("password");
  await db.destroy();
});

test("admin endpoint: non-admin 403, admin sees ALL sites", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await pub(app, "alice", "site-a", await tgz({ "index.html": "x" }));
  await pub(app, "bob", "site-b", await tgz({ "index.html": "x" }));
  expect((await call(app, "GET", "/v1/admin/sites", "bob")).status).toBe(403);
  const r = await call(app, "GET", "/v1/admin/sites", "alice");
  expect(r.status).toBe(200);
  expect((await r.json()).sites.map((s: any) => s.name).sort()).toEqual(["site-a", "site-b"]);
  await db.destroy();
});

test("admin cannot be spoofed via client-supplied flags/headers/body", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await pub(app, "alice", "site-a", await tgz({ "index.html": "x" }));
  // bob is authenticated but NOT an admin; every escalation trick must fail.
  for (const _ of [{ admin: true }, { email: "alice@example.com" }, { isAdmin: true, role: "admin" }]) {
    const res = await app.request("/v1/admin/sites", {
      method: "GET",
      headers: { authorization: "Bearer bob", "x-admin": "true", "x-drop-admin": "1" },
    });
    expect(res.status).toBe(403);
    void _;
  }
  const me = await app.request("/v1/me", { method: "GET", headers: { authorization: "Bearer bob", "x-admin": "true" } });
  expect(((await me.json()) as { admin: boolean }).admin).toBe(false);
  await db.destroy();
});

test("/v1/me reports admin flag from the users table", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  expect((await (await call(app, "GET", "/v1/me", "alice")).json()).admin).toBe(true);
  expect((await (await call(app, "GET", "/v1/me", "bob")).json()).admin).toBe(false);
  await db.destroy();
});

test("publish parses drop.yaml into config and does not serve it", async () => {
  const { app, meta, blob, db } = await mk();
  const tar = await tgz({
    "index.html": "<html>",
    "drop.yaml": "site:\n  spaFallback: app.html\n  redirects:\n    - from: /old\n      to: /new\n",
  });
  expect((await pub(app, "alice", "cfgsite", tar)).status).toBe(200);

  const site = (await meta.getSitePlain("cfgsite"))!;
  expect(site.config?.spaFallback).toBe("app.html");
  expect(site.config?.redirects?.[0]!.to).toBe("/new");

  const prefix = meta.filesPrefix("cfgsite", site.currentVersion!);
  expect(await blob.get(prefix + "drop.yaml")).toBeNull(); // not a served file
  expect(await blob.get(prefix + "index.html")).not.toBeNull();
  await db.destroy();
});

test("serves the self-contained CLI installer + bundles (public, no auth)", async () => {
  const { app, db } = await mk();
  const sh = await app.request("/install.sh");
  expect(sh.status).toBe(200);
  expect(sh.headers.get("content-type") ?? "").toContain("shellscript");
  const body = await sh.text();
  expect(body).toContain('API="http://localhost"'); // baked from the request host
  expect(body).toContain("/cli/drop.mjs"); // downloads the bundle this API serves
  expect(body).toContain('"apiBase"'); // auto-configures the CLI
  const js = await app.request("/cli/drop.mjs");
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type") ?? "").toContain("javascript");
  expect((await js.text()).length).toBeGreaterThan(1000); // the real bundle
  await db.destroy();
});

test("serves the docs site at /docs (public, no auth)", async () => {
  const { app, db } = await mk();
  const idx = await app.request("/docs/");
  expect(idx.status).toBe(200);
  expect(await idx.text()).toContain("Ship internal sites");
  const css = await app.request("/docs/assets/style.css");
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type") ?? "").toContain("css");
  const bare = await app.request("/docs");
  expect([301, 302, 307, 308]).toContain(bare.status);
  expect(bare.headers.get("location")).toBe("/docs/");

  // served-by-app signal: the API announces its own origin so the docs rewrite
  // their placeholder API URL to the live instance (positive opt-in, not a guess).
  const sig = await app.request("/docs/drop-served.js");
  expect(sig.status).toBe(200);
  expect(sig.headers.get("content-type") ?? "").toContain("javascript");
  expect(await sig.text()).toContain('window.__DROP_API_ORIGIN__ = "http://localhost"');
  // honors X-Forwarded-* (behind nginx/ALB)
  const fwd = await app.request("/docs/drop-served.js", {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "api.acme.internal" },
  });
  expect(await fwd.text()).toContain('window.__DROP_API_ORIGIN__ = "https://api.acme.internal"');
  await db.destroy();
});

test("publish rejects when drop.yaml name mismatches the target", async () => {
  const { app, db } = await mk();
  const tar = await tgz({ "index.html": "<html>", "drop.yaml": "site:\n  name: otherapp\n" });
  expect((await pub(app, "alice", "myapp", tar)).status).toBe(400);
  await db.destroy();
});

test("deploy: claims an app, applies manifests, sets pointer type=app", async () => {
  const { app, meta, kube, db } = await mk();
  const res = await call(app, "POST", "/v1/apps/billing", "alice", {
    image: "ecr/billing:v1",
    services: [{ internal_port: 8080, protocol: "http" }],
    scale: { min: 0, max: 3 },
  });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.url).toBe("https://billing.drop.example.com");
  expect(j.image).toBe("ecr/billing:v1");

  const site = (await meta.getSitePlain("billing"))!;
  expect(site.type).toBe("app");
  expect(site.owner).toBe("alice@example.com");
  expect(site.currentVersion).not.toBeNull();

  expect(kube.applies).toHaveLength(1);
  const m = kube.applies[0]!.manifests;
  expect((m.deployment as any).spec.template.spec.containers[0].image).toBe("ecr/billing:v1");
  expect((m.httpScaledObject as any).spec.hosts).toEqual(["billing.drop.example.com"]);
  await db.destroy();
});

test("deploy --no-start: app deploys STOPPED (no broken first boot); start brings it up", async () => {
  const { app, kube, meta, db } = await mk();
  const res = await call(app, "POST", "/v1/apps/blog?start=false", "alice", { image: "x:1", scale: { min: 1, max: 1 } });
  expect(res.status).toBe(200);
  expect((await res.json()).started).toBe(false); // never rolled out a running (secret-less) pod
  expect((await meta.getSitePlain("blog"))!.runtimeState).toBe("stopped");
  expect([...kube.stopped].some((k) => k.includes("blog"))).toBe(true); // pinned to 0 in the cluster
  // configure (secrets) happens here while stopped, then start → healthy first boot
  expect((await (await call(app, "POST", "/v1/apps/blog/start", "alice")).json()).state).toBe("running");
  expect((await meta.getSitePlain("blog"))!.runtimeState).toBe("running");
  // a plain deploy (no flag) still starts normally
  expect((await (await call(app, "POST", "/v1/apps/web2", "alice", { image: "x:1" })).json()).started).toBe(true);
  await db.destroy();
});

test("deploy: app and site names don't collide (409 both ways)", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "shared", await tgz({ "index.html": "x" })); // a site
  expect((await call(app, "POST", "/v1/apps/shared", "alice", { image: "x:1" })).status).toBe(409);
  await call(app, "POST", "/v1/apps/onlyapp", "alice", { image: "x:1" }); // an app
  expect((await pub(app, "alice", "onlyapp", await tgz({ "index.html": "x" }))).status).toBe(409);
  await db.destroy();
});

// ---- L1: release phase ----

test("deploy: a FAILING release Job halts the deploy — no manifests applied, old version keeps serving", async () => {
  const { app, kube, meta, db } = await mk();
  kube.scriptedReleases = [{ ok: false, reason: "failed", logs: "ERROR: relation \"todos\" does not exist\nmigration aborted" }];
  const res = await call(app, "POST", "/v1/apps/migrapp", "alice", { image: "todo:1", release: "npm run migrate" });
  expect(res.status).toBe(422);
  const j = await res.json();
  expect(j.releaseLogs).toContain("relation \"todos\" does not exist"); // the tail of the Job's pod logs
  // the release Job ran (after GC'ing priors) but the new Deployment was NEVER applied
  expect(kube.releaseJobDeletes).toHaveLength(1);
  expect(kube.releaseRuns).toHaveLength(1);
  expect(kube.applies).toHaveLength(0);
  // old state intact: the app is claimed but has no current version (nothing rolled out)
  expect((await meta.getSitePlain("migrapp"))!.currentVersion).toBeNull();
  await db.destroy();
});

test("deploy: a SUCCESSFUL release runs the Job then applies the new manifests + sets the pointer", async () => {
  const { app, kube, meta, db } = await mk();
  const res = await call(app, "POST", "/v1/apps/okapp", "alice", { image: "todo:1", release: "npm run migrate" });
  expect(res.status).toBe(200);
  expect(kube.releaseRuns).toHaveLength(1); // release ran
  expect(kube.applies).toHaveLength(1); // then the rollout happened
  const jobName = (kube.releaseRuns[0]!.job as any).metadata.name;
  expect(jobName).toMatch(/^okapp-release-/); // deterministic, version-scoped
  expect((await meta.getSitePlain("okapp"))!.currentVersion).not.toBeNull();
  await db.destroy();
});

test("deploy --no-start SKIPS the release phase (configure secrets first, then start)", async () => {
  const { app, kube, db } = await mk();
  const res = await call(app, "POST", "/v1/apps/stillapp?start=false", "alice", { image: "todo:1", release: "npm run migrate" });
  expect(res.status).toBe(200);
  expect(kube.releaseRuns).toHaveLength(0); // no migration against an unconfigured, not-yet-started app
  expect(kube.applies).toHaveLength(1);
  await db.destroy();
});

test("deploy: a held deploy lock → 409 (two deploys can't interleave migrations)", async () => {
  const { app, locks, db } = await mk();
  await locks.acquire("deploy:lockapp", "another-deploy", 60_000); // simulate an in-flight deploy
  const res = await call(app, "POST", "/v1/apps/lockapp", "alice", { image: "x:1" });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/already in progress/);
  await db.destroy();
});

// ---- L1: processes ----

test("deploy: worker-only app applies NO Service/HTTPScaledObject, just worker Deployments", async () => {
  const { app, kube, db } = await mk();
  const res = await call(app, "POST", "/v1/apps/batch", "alice", { image: "batch:1", processes: { worker: { command: "node w.js" } } });
  expect(res.status).toBe(200);
  const m = kube.applies[0]!.manifests;
  expect(m.service).toBeUndefined();
  expect(m.httpScaledObject).toBeUndefined();
  expect(m.deployment).toBeUndefined();
  expect(m.workers).toHaveLength(1);
  expect(m.workers![0]!.name).toBe("batch-worker");
  await db.destroy();
});

test("deploy: more than one web process → 400", async () => {
  const { app, db } = await mk();
  const res = await call(app, "POST", "/v1/apps/multi", "alice", {
    image: "x:1",
    processes: { web: { command: "a" }, worker: { web: true, command: "b" } },
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/at most one "web"/);
  await db.destroy();
});

test("GET /v1/apps/:name/processes aggregates per-process rows (web + worker)", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/multi2", "alice", {
    image: "x:1",
    processes: { web: { command: "a" }, worker: { command: "b" } },
  });
  const res = await call(app, "GET", "/v1/apps/multi2/processes", "alice");
  expect(res.status).toBe(200);
  const j = await res.json();
  const byProc = Object.fromEntries((j.processes as any[]).map((p) => [p.process, p]));
  expect(byProc.web).toMatchObject({ name: "multi2", web: true });
  expect(byProc.worker).toMatchObject({ name: "multi2-worker", web: false });
  await db.destroy();
});

test("GET /v1/sites/:name/logs?release=1 reads the latest release Job's pod logs", async () => {
  const { app, kube, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/logapp", "alice", { image: "x:1" });
  const ns = (await meta.getSitePlain("logapp"))!.namespace;
  kube.releaseLogs.set(`${ns}/logapp`, "running migrations...\ndone");
  const rel = await call(app, "GET", "/v1/sites/logapp/logs?release=1", "alice");
  expect((await rel.json()).logs).toBe("running migrations...\ndone");
  // without ?release it reads the app pods (empty by default), not the release logs
  kube.logsByName.set(`${ns}/logapp`, "app stdout");
  const app_ = await call(app, "GET", "/v1/sites/logapp/logs", "alice");
  expect((await app_.json()).logs).toBe("app stdout");
  await db.destroy();
});

// ---- G1: `drop logs -f` (streaming follow) ----

test("GET /v1/sites/:name/logs?follow=1 streams the scripted lines as chunked text/plain, then ends", async () => {
  const { app, kube, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/logapp", "alice", { image: "x:1" });
  const ns = (await meta.getSitePlain("logapp"))!.namespace;
  kube.scriptedLogStreams.set(`${ns}/logapp`, { lines: ["line one", "line two"] });
  const res = await app.request("/v1/sites/logapp/logs?follow=1", { headers: { authorization: "Bearer alice" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(await res.text()).toBe("line one\nline two\n");
  await db.destroy();
});

test("GET /v1/sites/:name/logs?follow=1 with no pod to follow -> empty stream, not an error", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/logapp", "alice", { image: "x:1" });
  // no scripted stream registered -> FakeKube's getWorkloadLogsStream returns null
  const res = await app.request("/v1/sites/logapp/logs?follow=1", { headers: { authorization: "Bearer alice" } });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
  await db.destroy();
});

test("GET /v1/sites/:name/logs?follow=1&release=1 is rejected — a release Job runs once, it can't be followed", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/logapp", "alice", { image: "x:1" });
  const res = await app.request("/v1/sites/logapp/logs?follow=1&release=1", { headers: { authorization: "Bearer alice" } });
  expect(res.status).toBe(400);
  await db.destroy();
});

test("GET /v1/sites/:name/logs?follow=1 aborts the upstream kube stream when the client disconnects", async () => {
  const { app, kube, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/logapp", "alice", { image: "x:1" });
  const ns = (await meta.getSitePlain("logapp"))!.namespace;
  kube.scriptedLogStreams.set(`${ns}/logapp`, { lines: ["still going"], keepOpen: true }); // never ends on its own
  const controller = new AbortController();
  const res = await app.request("/v1/sites/logapp/logs?follow=1", { headers: { authorization: "Bearer alice" }, signal: controller.signal });
  expect(res.status).toBe(200);
  expect(kube.logStreamAborts).toEqual([]); // not aborted yet
  controller.abort(); // simulate the client going away mid-stream
  expect(kube.logStreamAborts).toEqual([{ namespace: ns, name: "logapp" }]); // upstream torn down, no leaked socket
  await db.destroy();
});

test("image push: claims the app, streams the tarball to the ImageStore, returns the in-cluster ref", async () => {
  const { app, images, meta, db } = await mk();
  const body = new Uint8Array([1, 2, 3, 4, 5]);
  const res = await putImage(app, "alice", "imgapp", "v1", body);
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.image).toBe("drop.local/imgapp:v1");
  expect(j.version).toBe("v1");

  // the app was claimed (so `drop deploy --build` works before any deploy) + the push was recorded
  const site = (await meta.getSitePlain("imgapp"))!;
  expect(site.type).toBe("app");
  expect(site.owner).toBe("alice@example.com");
  expect(images.pushes).toHaveLength(1);
  expect(images.pushes[0]!.scope.app).toBe("imgapp");
  expect(images.pushes[0]!.scope.namespace).toMatch(/^drop-t-/);
  expect(images.pushes[0]!.version).toBe("v1");
  expect(images.pushes[0]!.bytes).toBe(5);
  await db.destroy();
});

test("image push: rejects a missing/invalid ?tag (would mismatch the imported ref)", async () => {
  const { app, images, db } = await mk();
  expect((await putImage(app, "alice", "imgapp", null, new Uint8Array([1]))).status).toBe(400);
  expect((await putImage(app, "alice", "imgapp", "bad tag!", new Uint8Array([1]))).status).toBe(400);
  expect(images.pushes).toHaveLength(0); // never reached the backend
  await db.destroy();
});

test("image push: type collision (site name) 409; non-owner 403", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "asite", await tgz({ "index.html": "x" })); // a site
  expect((await putImage(app, "alice", "asite", "v1", new Uint8Array([1]))).status).toBe(409);
  await call(app, "POST", "/v1/apps/aliceapp", "alice", { image: "x:1" }); // alice owns
  expect((await putImage(app, "bob", "aliceapp", "v1", new Uint8Array([1]))).status).toBe(403);
  await db.destroy();
});

test("image push: 413 when the upload exceeds the configured size cap", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@example.com", null);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_S3_ENDPOINT: "http://localhost:4566", DROP_IMAGE_MAX_BYTES: "4" });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const images = new FakeImageStore();
  const app = createApp({ cfg, meta: new MetaStore(db), blob: new FakeBlob(), db, users, verifier, kube: new FakeKube(), secrets: new FakeSecretStore(), images, orgs: new OrgStore(db), audit: new AuditStore(db) });
  const res = await putImage(app, "alice", "bigapp", "v1", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); // 8 > 4-byte cap
  expect(res.status).toBe(413);
  expect(images.pushes).toHaveLength(0); // aborted mid-stream, never recorded
  await db.destroy();
});

test("image push: 501 when compute is disabled (no kube)", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@example.com", null);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_S3_ENDPOINT: "http://localhost:4566" });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const app = createApp({ cfg, meta: new MetaStore(db), blob: new FakeBlob(), db, users, verifier, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(db), audit: new AuditStore(db) }); // no kube
  expect((await putImage(app, "alice", "imgapp", "v1", new Uint8Array([1]))).status).toBe(501);
  await db.destroy();
});

test("deploy: non-owner 403; bad config 400", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" }); // alice owns
  expect((await call(app, "POST", "/v1/apps/billing", "bob", { image: "y:1" })).status).toBe(403);
  expect((await call(app, "POST", "/v1/apps/noimg", "alice", { foo: 1 })).status).toBe(400);
  expect(
    (await call(app, "POST", "/v1/apps/tcpapp", "alice", { image: "x:1", services: [{ internal_port: 5432, protocol: "tcp" }] })).status,
  ).toBe(400);
  await db.destroy();
});

test("deploy: 501 when compute is not enabled (no kube)", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com" });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const app = createApp({ cfg, meta: new MetaStore(db), blob: new FakeBlob(), db, users, verifier, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(db), audit: new AuditStore(db) }); // no kube
  expect((await call(app, "POST", "/v1/apps/x", "alice", { image: "x:1" })).status).toBe(501);
  await db.destroy();
});

test("deploy provisions a per-owner tenant namespace with isolation objects + env Secret", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1", env: { K: "v" } });
  const ns = kube.tenantApplies[0]!.namespace;
  expect(ns).toMatch(/^drop-t-/); // per-owner namespace, not a shared one
  expect(kube.applies[0]!.namespace).toBe(ns); // app applied into the tenant ns
  const t = kube.tenantApplies[0]!.manifests;
  expect((t.resourceQuota as any).spec.hard["count/pods"]).toBeDefined();
  expect((t.networkPolicy as any).spec.policyTypes).toContain("Egress");
  expect((kube.applies[0]!.manifests.secret as any).stringData.K).toBe("v"); // env in a Secret, not the pod spec
  await db.destroy();
});

test("delete: app deletion tears down the k8s workload (no orphan)", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1", env: { K: "v" } });
  const ns = kube.applies[0]!.namespace;
  expect((await call(app, "DELETE", "/v1/sites/billing", "alice")).status).toBe(200);
  expect(kube.deletes).toContainEqual({ namespace: ns, name: "billing" });
  await db.destroy();
});

test("delete: a stateful app requires ?force=1 (409) — data-loss gate on its volume", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/notes", "alice", { image: "x:1", stateful: { volume: "2Gi", mount: "/data" } });
  const ns = kube.applies[0]!.namespace;

  const refused = await call(app, "DELETE", "/v1/sites/notes", "alice");
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toMatch(/stateful.*volume|force=1/i);
  expect(kube.deletes).toEqual([]); // refused BEFORE any teardown

  const forced = await call(app, "DELETE", "/v1/sites/notes?force=1", "alice");
  expect(forced.status).toBe(200);
  expect(kube.deletes).toContainEqual({ namespace: ns, name: "notes", dropVolume: true }); // PVC removal requested
  await db.destroy();
});

test("delete: a NON-stateful app never sets dropVolume, even with ?force=1", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const ns = kube.applies[0]!.namespace;
  expect((await call(app, "DELETE", "/v1/sites/billing?force=1", "alice")).status).toBe(200);
  expect(kube.deletes).toContainEqual({ namespace: ns, name: "billing" }); // no dropVolume key at all
  await db.destroy();
});

test("transfer: app workload is removed from the OLD owner's namespace", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const oldNs = kube.applies[0]!.namespace;
  expect((await call(app, "POST", "/v1/sites/billing/transfer", "alice", { email: "bob@example.com" })).status).toBe(200);
  expect(kube.deletes).toContainEqual({ namespace: oldNs, name: "billing" }); // not orphaned under the prior owner
  await db.destroy();
});

test("transfer: app secrets are torn down + the registry cleared (not leaked under the old owner)", async () => {
  const { app, kube, secrets, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const oldNs = kube.applies[0]!.namespace;
  await call(app, "PUT", "/v1/apps/billing/secrets/API_KEY", "alice", { value: "s3cr3t" });
  expect(await meta.listSecretKeys("billing")).toHaveLength(1);
  const r = await call(app, "POST", "/v1/sites/billing/transfer", "alice", { email: "bob@example.com" });
  expect(r.status).toBe(200);
  expect((await r.json()).secretsDropped).toBe(true);
  expect(secrets.destroyed).toContain(`${oldNs}/billing`); // old-namespace secret material reaped
  expect(await meta.listSecretKeys("billing")).toEqual([]); // registry no longer advertises gone keys
  await db.destroy();
});

test("auth: principal email is canonicalized to lowercase (no case-fold tenant collision)", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const meta = new MetaStore(db);
  const kube = new FakeKube();
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com" });
  const verifier = new FakeVerifier({
    upper: { sub: "Alice@Example.com", email: "Alice@Example.com" },
    lower: { sub: "alice@example.com", email: "alice@example.com" },
  });
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, kube, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(db), audit: new AuditStore(db) });
  expect((await call(app, "POST", "/v1/apps/billing", "upper", { image: "x:1" })).status).toBe(200);
  const site = (await meta.getSitePlain("billing"))!;
  expect(site.owner).toBe("alice@example.com"); // owner stored canonical (not "Alice@Example.com")
  // the lowercase variant is the SAME principal → owner, not a foreign 403
  expect((await call(app, "POST", "/v1/apps/billing", "lower", { image: "x:2" })).status).toBe(200);
  await db.destroy();
});

test("orgs: team org grants org-WIDE rights; non-members blocked; member can't delete; personal default", async () => {
  const { app, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  // deploy a resource INTO the org (?org=acme)
  expect((await call(app, "POST", "/v1/apps/billing?org=acme", "alice", { image: "x:1" })).status).toBe(200);
  // bob is not a member → no access to the org's resource, and can't create in the org
  expect((await call(app, "GET", "/v1/sites/billing", "bob")).status).toBe(403);
  expect((await call(app, "POST", "/v1/apps/other?org=acme", "bob", { image: "x:1" })).status).toBe(403);
  // add bob as an org member → org-WIDE access (read + deploy + configure across the org)
  expect((await call(app, "POST", "/v1/orgs/acme/members", "alice", { email: "bob@example.com", role: "member" })).status).toBe(200);
  expect((await call(app, "GET", "/v1/sites/billing", "bob")).status).toBe(200);
  // an org member sees the org's resources in their list (not just per-resource grants)
  expect((await (await call(app, "GET", "/v1/sites", "bob")).json()).sites.map((s: any) => s.name)).toContain("billing");
  expect((await call(app, "PUT", "/v1/apps/billing/secrets/API_KEY", "bob", { value: "v" })).status).toBe(200); // member → configure
  // a member can't delete (owner/admin only)
  expect((await call(app, "DELETE", "/v1/sites/billing", "bob")).status).toBe(403);
  // listing orgs shows both the personal org and the team org
  const orgs = (await (await call(app, "GET", "/v1/orgs", "alice")).json()).orgs;
  expect(orgs.map((o: any) => o.slug)).toContain("acme");
  expect(orgs.some((o: any) => o.kind === "personal")).toBe(true);
  // a bad slug → 400
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "Bad Slug" })).status).toBe(400);
  await db.destroy();
});

test("deploy with uses:[{database}] binds the DB; FakeKube gets envFrom <db>-app + CA + verify-full", async () => {
  const { app, kube, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/tododb?org=acme", "alice", {})).status).toBe(200); // a DB in the org
  const res = await call(app, "POST", "/v1/apps/todo?org=acme", "alice", { image: "todo:1", uses: [{ database: "tododb" }] });
  expect(res.status).toBe(200);
  // the binding reached kube exactly as the manifest layer emits it
  const applied = kube.applies.find((a) => a.name === "todo")!.manifests;
  const ctr = (applied.deployment as any).spec.template.spec.containers[0];
  expect(ctr.envFrom[0]).toEqual({ secretRef: { name: "tododb-app" } });
  expect(ctr.env).toContainEqual({ name: "PGSSLMODE", value: "verify-full" });
  expect(ctr.env).toContainEqual({ name: "PGSSLROOTCERT", value: "/var/run/drop/db-ca/tododb/ca.crt" });
  expect((applied.deployment as any).spec.template.spec.volumes[0].secret.secretName).toBe("tododb-ca");
  await db.destroy();
});

test("deploy uses:[{database}] referencing a missing database → 400 naming it", async () => {
  const { app, db } = await mk();
  const res = await call(app, "POST", "/v1/apps/todo", "alice", { image: "todo:1", uses: [{ database: "ghostdb" }] });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("ghostdb");
  await db.destroy();
});

test("deploy cannot bind a database in a DIFFERENT org → 400", async () => {
  const { app, db } = await mk();
  expect((await call(app, "POST", "/v1/databases/alicedb", "alice", {})).status).toBe(200); // alice's personal org
  // bob (different owner → different personal org) tries to bind alice's DB
  const res = await call(app, "POST", "/v1/apps/bobapp", "bob", { image: "x:1", uses: [{ database: "alicedb" }] });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("different organisation");
  await db.destroy();
});

test("H3 deploy uses:[{app}]: always-on target → in-cluster Service URL; scale-to-zero target → public wake host", async () => {
  const { app, kube, meta, db } = await mk();
  // an always-on peer (min ≥ 1) and a scale-to-zero peer (default min 0), both alice's (same ns)
  expect((await call(app, "POST", "/v1/apps/backend", "alice", { image: "b:1", scale: { min: 1, max: 2 } })).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/coldsvc", "alice", { image: "c:1" })).status).toBe(200); // default scale {min:0}
  const res = await call(app, "POST", "/v1/apps/frontend", "alice", { image: "f:1", uses: [{ app: "backend" }, { app: "coldsvc" }] });
  expect(res.status).toBe(200);
  const ns = (await meta.getSitePlain("frontend"))!.namespace;
  const ctr = (kube.applies.find((a) => a.name === "frontend")!.manifests.deployment as any).spec.template.spec.containers[0];
  // BACKEND is always-on → dial its Service directly (lowest latency); COLDSVC scales to zero → its
  // public host, which wakes it through the edge → KEDA interceptor (documented added latency).
  expect(ctr.env).toContainEqual({ name: "BACKEND_URL", value: `http://backend.${ns}.svc.cluster.local:80` });
  expect(ctr.env).toContainEqual({ name: "COLDSVC_URL", value: "https://coldsvc.drop.example.com" });
  await db.destroy();
});

test("H3 deploy uses:[{app}] refuses a missing target, a cross-org target, and self-reference", async () => {
  const { app, db } = await mk();
  // missing
  const missing = await call(app, "POST", "/v1/apps/f1", "alice", { image: "x:1", uses: [{ app: "ghostapp" }] });
  expect(missing.status).toBe(400);
  expect((await missing.json()).error).toContain("ghostapp");
  // cross-org: bob (his own personal org) tries to use alice's app
  expect((await call(app, "POST", "/v1/apps/aliceapp", "alice", { image: "x:1" })).status).toBe(200);
  const cross = await call(app, "POST", "/v1/apps/bobapp", "bob", { image: "x:1", uses: [{ app: "aliceapp" }] });
  expect(cross.status).toBe(400);
  expect((await cross.json()).error).toContain("different organisation");
  // self-reference
  const self = await call(app, "POST", "/v1/apps/loopapp", "alice", { image: "x:1", uses: [{ app: "loopapp" }] });
  expect(self.status).toBe(400);
  expect((await self.json()).error).toContain("cannot use itself");
  await db.destroy();
});

test("app secrets: write-only set/list/delete (owner), value NEVER returned; deploy reconciles the binding", async () => {
  const { app, secrets, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  // deploy reconciled the (empty) injection binding
  expect(secrets.bindings.at(-1)).toEqual({ scope: expect.stringContaining("/billing"), keys: [] });

  const r = await call(app, "PUT", "/v1/apps/billing/secrets/API_KEY", "alice", { value: "s3cr3t-value" });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.key).toBe("API_KEY");
  expect(j.fingerprint).toBeTruthy();
  expect(JSON.stringify(j)).not.toContain("s3cr3t-value"); // the value is NEVER in a response
  expect([...secrets.values.values()].some((m) => m.get("API_KEY") === "s3cr3t-value")).toBe(true); // stored in the backend
  expect(secrets.bindings.at(-1)!.keys).toEqual(["API_KEY"]); // binding reconciled with the new key

  const list = await (await call(app, "GET", "/v1/apps/billing/secrets", "alice")).json();
  expect(list.secrets).toEqual([{ key: "API_KEY", fingerprint: j.fingerprint, updatedBy: "alice@example.com", updatedAt: expect.any(String) }]);
  expect(JSON.stringify(list)).not.toContain("s3cr3t-value");

  // editor cannot manage secrets (configure = owner/admin)
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  expect((await call(app, "PUT", "/v1/apps/billing/secrets/OTHER", "bob", { value: "x" })).status).toBe(403);
  expect((await call(app, "GET", "/v1/apps/billing/secrets", "bob")).status).toBe(403);

  // delete
  expect((await call(app, "DELETE", "/v1/apps/billing/secrets/API_KEY", "alice")).status).toBe(200);
  expect((await (await call(app, "GET", "/v1/apps/billing/secrets", "alice")).json()).secrets).toEqual([]);
  expect(secrets.bindings.at(-1)!.keys).toEqual([]);
  await db.destroy();
});

test("app lifecycle: restart/stop/start (editor+), runtime_state tracked; redeploy honors stopped", async () => {
  const { app, kube, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const ns = kube.applies[0]!.namespace;
  // editor can operate the runtime (deploy-level)
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  expect((await call(app, "POST", "/v1/apps/billing/restart", "bob")).status).toBe(200);
  expect(kube.restarts.at(-1)).toEqual({ namespace: ns, name: "billing" });
  // stop → true offline + runtime_state
  expect((await (await call(app, "POST", "/v1/apps/billing/stop", "alice")).json()).state).toBe("stopped");
  expect(kube.stopped.has(`${ns}/billing`)).toBe(true);
  expect((await meta.getSitePlain("billing"))!.runtimeState).toBe("stopped");
  // restart while stopped is a 409 (would be a silent no-op against pinned-to-0 pods)
  expect((await call(app, "POST", "/v1/apps/billing/restart", "alice")).status).toBe(409);
  // a redeploy must NOT silently wake it (re-applies stop)
  kube.stopped.delete(`${ns}/billing`);
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:2" });
  expect(kube.stopped.has(`${ns}/billing`)).toBe(true);
  // detail shows Stopped
  const det = await (await call(app, "GET", "/v1/sites/billing", "alice")).json();
  expect(det.app.runtimeState).toBe("stopped");
  expect(det.app.status.reason).toBe("Stopped");
  // start → running
  expect((await (await call(app, "POST", "/v1/apps/billing/start", "alice")).json()).state).toBe("running");
  expect((await meta.getSitePlain("billing"))!.runtimeState).toBe("running");
  await db.destroy();
});

test("visibility is static-site only (409 on an app); no fail-open visibility", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/myapp", "alice", { image: "x:1" });
  // an app must not be settable to private/password (the edge proxy path can't enforce it → fail-open)
  expect((await call(app, "POST", "/v1/sites/myapp/visibility", "alice", { visibility: "private" })).status).toBe(409);
  // a single-version app has nothing to roll back TO yet (H1 rollback itself is exercised below)
  expect((await call(app, "POST", "/v1/sites/myapp/rollback", "alice", {})).status).toBe(400);
  await db.destroy();
});

test("rollback is database-only-409 (no version bytes / stored config equivalent to restore from)", async () => {
  const { app, db } = await mk();
  const dbCfg = { storage: "1Gi" };
  await call(app, "POST", "/v1/databases/mydb", "alice", dbCfg);
  const res = await call(app, "POST", "/v1/sites/mydb/rollback", "alice", {});
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/restore-from-backup/);
  await db.destroy();
});

// ---- H1: app rollback ----

test("app rollback: re-applies the target version's stored config (old image + fresh version annotation); currentVersion flips", async () => {
  const { app, kube, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:2" });
  const ns = (await meta.getSitePlain("billing"))!.namespace;
  const before = await meta.listVersions("billing");
  const currentBefore = (await meta.getSitePlain("billing"))!.currentVersion;
  const target = before.find((v) => v.id !== currentBefore)!.id;

  const appliesBefore = kube.applies.length;
  const res = await call(app, "POST", "/v1/sites/billing/rollback", "alice", {});
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.version).toBe(target);

  // a NEW apply was made (re-applying the OLD version's manifests), not a no-op
  expect(kube.applies.length).toBe(appliesBefore + 1);
  const lastApply = kube.applies[kube.applies.length - 1]!;
  expect(lastApply.namespace).toBe(ns);
  const ctr = (lastApply.manifests.deployment as any).spec.template.spec.containers[0];
  expect(ctr.image).toBe("x:1"); // the TARGET version's image, not the currently-running x:2
  // the pod-template annotation carries the TARGET version id, so pods roll even if the image
  // string happened to match what's currently deployed.
  expect((lastApply.manifests.deployment as any).spec.template.metadata.annotations).toEqual({ "drop.dev/version": target });

  expect((await meta.getSitePlain("billing"))!.currentVersion).toBe(target);
  await db.destroy();
});

test("app rollback: target version predates rollback support (no stored config) -> 409", async () => {
  const { app, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  // simulate a version deployed before H1 shipped: no config was ever recorded on the row.
  await meta.putVersion("billing", { id: "v_pre_h1", publishedBy: "alice@example.com", createdAt: new Date().toISOString(), fileCount: 0, bytes: 0 });
  const res = await call(app, "POST", "/v1/sites/billing/rollback", "alice", { to: "v_pre_h1" });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/predates rollback support/);
  await db.destroy();
});

test("app rollback: a stopped app stays stopped", async () => {
  const { app, kube, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:2" });
  await call(app, "POST", "/v1/apps/billing/stop", "alice");
  const ns = (await meta.getSitePlain("billing"))!.namespace;
  expect(kube.stopped.has(`${ns}/billing`)).toBe(true);

  const res = await call(app, "POST", "/v1/sites/billing/rollback", "alice", {});
  expect(res.status).toBe(200);
  expect(kube.stopped.has(`${ns}/billing`)).toBe(true); // rollback must not silently wake it
  await db.destroy();
});

test("app rollback: a held deploy lock -> 409 (serialized under the SAME deploy lock as `drop deploy`)", async () => {
  const { app, locks, db } = await mk();
  await call(app, "POST", "/v1/apps/lockapp", "alice", { image: "x:1" });
  await call(app, "POST", "/v1/apps/lockapp", "alice", { image: "x:2" });
  await locks.acquire("deploy:lockapp", "another-deploy", 60_000); // simulate an in-flight deploy
  const res = await call(app, "POST", "/v1/sites/lockapp/rollback", "alice", {});
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/already in progress/);
  await db.destroy();
});

test("app lifecycle: viewer forbidden; non-app 409", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  expect((await call(app, "POST", "/v1/apps/billing/restart", "bob")).status).toBe(403);
  await pub(app, "alice", "asite", await tgz({ "index.html": "x" }));
  expect((await call(app, "POST", "/v1/apps/asite/stop", "alice")).status).toBe(409);
  await db.destroy();
});

test("app secrets: validation + type/existence guards", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  expect((await call(app, "PUT", "/v1/apps/billing/secrets/bad-key", "alice", { value: "x" })).status).toBe(400); // not UPPER_SNAKE
  expect((await call(app, "PUT", "/v1/apps/billing/secrets/API_KEY", "alice", {})).status).toBe(400); // value required
  await pub(app, "alice", "asite", await tgz({ "index.html": "x" }));
  expect((await call(app, "PUT", "/v1/apps/asite/secrets/API_KEY", "alice", { value: "x" })).status).toBe(409); // a site, not an app
  expect((await call(app, "PUT", "/v1/apps/nope/secrets/API_KEY", "alice", { value: "x" })).status).toBe(404);
  await db.destroy();
});

test("db:create claims type=database, applies CNPG manifests, returns a connection ref (no password)", async () => {
  const { app, meta, kube, db } = await mk();
  const res = await call(app, "POST", "/v1/databases/billing", "alice", { storage: "512Mi", hibernation: "scheduled" });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.host).toBe(`billing-rw.${kube.dbApplies[0]!.namespace}.svc.cluster.local`);
  expect(j.port).toBe(5432);
  expect(j.database).toBe("app");
  expect(j.user).toBe("app");
  expect(j.credentialsSecret).toBe("billing-app");
  expect(JSON.stringify(j)).not.toContain("password"); // never leak credentials in the response

  const site = (await meta.getSitePlain("billing"))!;
  expect(site.type).toBe("database");

  expect(kube.dbApplies).toHaveLength(1);
  const m = kube.dbApplies[0]!.manifests;
  expect((m.cluster as any).spec.plugins[0].name).toBe("barman-cloud.cloudnative-pg.io");
  expect((m.cluster as any).spec.storage.size).toBe("512Mi");
  expect((m.cluster as any).metadata.labels["drop.dev/hibernation"]).toBe("scheduled");
  expect((m.objectStore as any).apiVersion).toBe("barmancloud.cnpg.io/v1");
  await db.destroy();
});

test("db:create emits a platform-owned basic-auth app Secret (bootstrap source) — password never in the response", async () => {
  const { app, kube, db } = await mk();
  const res = await call(app, "POST", "/v1/databases/billing", "alice", {});
  expect(JSON.stringify(await res.json())).not.toContain("password");
  const m = kube.dbApplies[0]!.manifests as any;
  expect(m.appSecret.type).toBe("kubernetes.io/basic-auth");
  expect(m.appSecret.metadata.name).toBe("billing-app");
  expect(m.appSecret.stringData.username).toBe("app");
  expect(m.appSecret.stringData.password.length).toBeGreaterThanOrEqual(12);
  // re-apply (update) must NOT re-emit the Secret (never silently rotate the password)
  await call(app, "POST", "/v1/databases/billing", "alice", { storage: "512Mi" });
  expect((kube.dbApplies[1]!.manifests as any).appSecret).toBeUndefined();
  await db.destroy();
});

test("db:create rejects a storage request over the 1Gi cap with a 400 (control-plane enforcement)", async () => {
  const { app, kube, db } = await mk();
  const res = await call(app, "POST", "/v1/databases/toobig", "alice", { storage: "5Gi" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/exceeds the 1Gi/);
  expect(kube.dbApplies).toHaveLength(0); // nothing provisioned
  // at/under the cap is accepted
  expect((await call(app, "POST", "/v1/databases/okdb", "alice", { storage: "1Gi" })).status).toBe(200);
  await db.destroy();
});

test("db password: owner rotates (200, password once + kube called); editor forbidden (configure, not db:create)", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  // an editor can create/update DBs (db:create) but must NOT rotate credentials (configure)
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  expect((await call(app, "POST", "/v1/databases/billing/password", "bob", {})).status).toBe(403);
  const r = await call(app, "POST", "/v1/databases/billing/password", "alice", {});
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.user).toBe("app");
  expect(j.password.length).toBeGreaterThanOrEqual(12);
  expect(kube.passwordSets).toHaveLength(1);
  expect(kube.passwordSets[0]!.name).toBe("billing");
  expect(kube.passwordSets[0]!.password).toBe(j.password); // the secret set IS what we returned
  await db.destroy();
});

test("db password: a partial rotation (role changed, Secret sync failed) still returns the live password (200 + warning), never a 502", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  kube.passwordSyncFail = true; // role rotates but the creds Secret write fails
  const r = await call(app, "POST", "/v1/databases/billing/password", "alice", {});
  expect(r.status).toBe(200); // NOT 502 — the password is now the only live copy
  const j = await r.json();
  expect(j.password.length).toBeGreaterThanOrEqual(12);
  expect(j.warning).toBeTruthy();
  expect(kube.passwordSets[0]!.password).toBe(j.password); // the rotation did happen
  await db.destroy();
});

test("db password: concurrent rotations are serialized — the second gets 409 (no Job/Secret stomp)", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  let release!: () => void;
  kube.passwordGate = new Promise<void>((r) => { release = r; }); // hold the first rotation in-flight
  const first = call(app, "POST", "/v1/databases/billing/password", "alice", {});
  await new Promise((r) => setTimeout(r, 25)); // let the first acquire the per-name lock
  const second = await call(app, "POST", "/v1/databases/billing/password", "alice", {});
  expect(second.status).toBe(409); // a rotation is already in progress
  release();
  expect((await first).status).toBe(200);
  expect(kube.passwordSets).toHaveLength(1); // only the first actually rotated
  await db.destroy();
});

test("db password: validates a caller-supplied password; 409 on a non-database; 404 when missing", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  expect((await call(app, "POST", "/v1/databases/billing/password", "alice", { password: "short" })).status).toBe(400);
  const ok = await call(app, "POST", "/v1/databases/billing/password", "alice", { password: "a-valid-password-123" });
  expect((await ok.json()).password).toBe("a-valid-password-123"); // honored verbatim
  await pub(app, "alice", "asite", await tgz({ "index.html": "x" }));
  expect((await call(app, "POST", "/v1/databases/asite/password", "alice", {})).status).toBe(409); // a site, not a db
  expect((await call(app, "POST", "/v1/databases/nope/password", "alice", {})).status).toBe(404); // unknown
  await db.destroy();
});

test("db tunnel-ticket (A3): connect-tier issuance — owner + editor issue, a viewer is 403, unknown 404, 501 static-only", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  // owner issues a single-use ticket bound to the DB
  const r = await call(app, "POST", "/v1/databases/billing/tunnel-ticket", "alice", {});
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.db).toBe("billing");
  expect(j.ticket.startsWith("drop_tt_")).toBe(true);
  expect(j.wsPath).toBe("/v1/databases/billing/tunnel");
  expect(new Date(j.expiresAt).getTime()).toBeGreaterThan(Date.now());
  // an editor may open a tunnel (connect is the deploy/ship tier), a viewer may not
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  expect((await call(app, "POST", "/v1/databases/billing/tunnel-ticket", "bob", {})).status).toBe(200);
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "viewer" }); // demote bob
  expect((await call(app, "POST", "/v1/databases/billing/tunnel-ticket", "bob", {})).status).toBe(403); // viewer: metadata-only
  // 404 for an unknown DB, 409 for a non-database name
  expect((await call(app, "POST", "/v1/databases/nope/tunnel-ticket", "alice", {})).status).toBe(404);
  await pub(app, "alice", "asite", await tgz({ "index.html": "x" }));
  expect((await call(app, "POST", "/v1/databases/asite/tunnel-ticket", "alice", {})).status).toBe(409);
  await db.destroy();
});

// ---- (I4) SQL console: read-only query API ------------------------------------------------------

// A scripted fake executor injected into Deps: records every request the route hands it (so we can
// assert the caps + timeout the route requests) and returns a scripted result or throws a scripted
// error. Read-only enforcement itself (BEGIN READ ONLY + statement_timeout at the engine) lives in the
// REAL executor (src/api/sql-query.ts) and is integration-tested MANUALLY against a real Postgres — the
// repo's test infra is PGlite, so here the executor is faked and we assert the route's contract with it.
function fakeExecutor(script: { result?: any; error?: string }) {
  const calls: any[] = [];
  const fn = async (req: any) => {
    calls.push(req);
    if (script.error) throw new Error(script.error);
    return script.result;
  };
  (fn as any).calls = calls;
  return fn as any;
}
const okResult = { columns: [{ name: "id" }, { name: "name" }], rows: [[1, "a"], [2, "b"]], rowCount: 2, truncated: false, elapsedMs: 3 };

test("db query (I4): owner runs a read-only query; the route requests the caps + 5s timeout; audited with the statement", async () => {
  const exec = fakeExecutor({ result: okResult });
  const { app, audit, db } = await mk({ env: { DROP_TUNNEL_DIRECT: "1" }, queryExecutor: exec });
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  const r = await call(app, "POST", "/v1/databases/billing/query", "alice", { sql: "select id, name from t" });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.columns).toEqual([{ name: "id" }, { name: "name" }]);
  expect(j.rows).toEqual([[1, "a"], [2, "b"]]);
  expect(j.rowCount).toBe(2);
  expect(j.truncated).toBe(false);
  expect(typeof j.elapsedMs).toBe("number");
  // the route DELEGATES enforcement — it must request the read-only caps + 5s timeout from the executor
  expect(exec.calls).toHaveLength(1);
  expect(exec.calls[0].sql).toBe("select id, name from t");
  expect(exec.calls[0].database).toBe("billing");
  expect(exec.calls[0].rowCap).toBe(500);
  expect(exec.calls[0].statementTimeoutMs).toBe(5000);
  expect(exec.calls[0].byteCap).toBeGreaterThan(0);
  // audited: db.query with the exact statement text (i.e. queries are logged)
  const { entries } = await audit.list({ action: "db.query", target: "billing" });
  expect(entries).toHaveLength(1);
  expect(entries[0]!.actor).toBe("alice@example.com");
  expect(entries[0]!.detail?.sql).toBe("select id, name from t");
  expect(entries[0]!.detail?.ok).toBe(true);
  await db.destroy();
});

test("db query: the executor's row-cap truncation flag passes through", async () => {
  const exec = fakeExecutor({ result: { ...okResult, rowCount: 500, truncated: true } });
  const { app, db } = await mk({ env: { DROP_TUNNEL_DIRECT: "1" }, queryExecutor: exec });
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  const r = await call(app, "POST", "/v1/databases/billing/query", "alice", { sql: "select * from big" });
  expect(r.status).toBe(200);
  expect((await r.json()).truncated).toBe(true);
  await db.destroy();
});

test("db query: a SQL/engine error is a 400 with the sanitized message; the failed attempt is still audited", async () => {
  const exec = fakeExecutor({ error: 'relation "nope" does not exist' });
  const { app, audit, db } = await mk({ env: { DROP_TUNNEL_DIRECT: "1" }, queryExecutor: exec });
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  const r = await call(app, "POST", "/v1/databases/billing/query", "alice", { sql: "select * from nope" });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toBe('relation "nope" does not exist'); // no stack — just the pg message
  const { entries } = await audit.list({ action: "db.query", target: "billing" });
  expect(entries).toHaveLength(1);
  expect(entries[0]!.detail?.ok).toBe(false);
  await db.destroy();
});

test("db query: editor allowed, viewer 403; non-database 409; unknown 404; empty sql 400", async () => {
  const exec = fakeExecutor({ result: okResult });
  const { app, db } = await mk({ env: { DROP_TUNNEL_DIRECT: "1" }, queryExecutor: exec });
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  // an editor may query (query is the ship/dev tier)
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  expect((await call(app, "POST", "/v1/databases/billing/query", "bob", { sql: "select 1" })).status).toBe(200);
  // a viewer may NOT — metadata-only, and a query returns ALL row data
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  expect((await call(app, "POST", "/v1/databases/billing/query", "bob", { sql: "select 1" })).status).toBe(403);
  // empty sql → 400
  expect((await call(app, "POST", "/v1/databases/billing/query", "alice", { sql: "   " })).status).toBe(400);
  // a site (non-database) → 409; unknown → 404
  await pub(app, "alice", "asite", await tgz({ "index.html": "x" }));
  expect((await call(app, "POST", "/v1/databases/asite/query", "alice", { sql: "select 1" })).status).toBe(409);
  expect((await call(app, "POST", "/v1/databases/nope/query", "alice", { sql: "select 1" })).status).toBe(404);
  await db.destroy();
});

test("db query: an out-of-cluster API 501s honestly (DROP_TUNNEL_DIRECT unset) and never dials the executor", async () => {
  const exec = fakeExecutor({ result: okResult });
  // tunnelDirect unset (default) → the API has no route to the DB Service → 501 before the executor runs
  const { app, db } = await mk({ queryExecutor: exec });
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  const r = await call(app, "POST", "/v1/databases/billing/query", "alice", { sql: "select 1" });
  expect(r.status).toBe(501);
  expect((await r.json()).error).toContain("in-cluster");
  expect(exec.calls).toHaveLength(0); // never dialed
  await db.destroy();
});

test("db query: the detail capabilities include `query` for the owner, not for a viewer (M2 console gating)", async () => {
  const { app, db } = await mk({ env: { DROP_TUNNEL_DIRECT: "1" } });
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  const asOwner = await (await call(app, "GET", "/v1/sites/billing", "alice")).json();
  expect(asOwner.capabilities).toContain("query");
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  const asViewer = await (await call(app, "GET", "/v1/sites/billing", "bob")).json();
  expect(asViewer.capabilities).not.toContain("query");
  await db.destroy();
});

test("db tunnel-ticket: a `connect`-scoped service token issues; a token without connect is 403", async () => {
  const { app, orgs, tokens, db } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  await call(app, "POST", "/v1/databases/billing?org=acme", "alice", {}); // a DB in the acme org
  const org = await orgs.getOrgBySlug("acme");
  const withConnect = (await tokens.create(org!.id, "ci", ["connect:billing"], null, "alice@example.com")).token;
  const noConnect = (await tokens.create(org!.id, "ci2", ["read:billing"], null, "alice@example.com")).token;
  expect((await call(app, "POST", "/v1/databases/billing/tunnel-ticket", withConnect, {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/billing/tunnel-ticket", noConnect, {})).status).toBe(403);
  await db.destroy();
});

test("db tunnel-ticket: 501 when compute is disabled (static-only instance)", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com" });
  const fake = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const tokens = new ServiceTokenStore(db);
  const verifier = new ChainVerifier([new TokenVerifier(tokens, orgs), fake]);
  // No `kube` → compute disabled.
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs, audit: new AuditStore(db), bucket: new FakeBucketStore(), quotas: new QuotaStore(db), tokens });
  expect((await call(app, "POST", "/v1/databases/whatever/tunnel-ticket", "alice", {})).status).toBe(501);
  await db.destroy();
});

test("db:create provisions the tenant namespace (isolation objects) before the DB", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  expect(kube.tenantApplies).toHaveLength(1);
  expect(kube.tenantApplies[0]!.namespace).toBe(kube.dbApplies[0]!.namespace);
  await db.destroy();
});

test("db:create — names don't collide with sites/apps (409); non-owner 403; no kube 501", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "shared", await tgz({ "index.html": "x" })); // a site
  expect((await call(app, "POST", "/v1/databases/shared", "alice", {})).status).toBe(409); // site, not a db
  await call(app, "POST", "/v1/databases/billing", "alice", {}); // alice owns it
  expect((await call(app, "POST", "/v1/databases/billing", "bob", {})).status).toBe(403); // foreign owner
  await db.destroy();

  const db2 = await makeTestDb();
  const users = new UserStore(db2);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com" });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const noKube = createApp({ cfg, meta: new MetaStore(db2), blob: new FakeBlob(), db: db2, users, verifier, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(db2), audit: new AuditStore(db2) }); // no kube
  expect((await call(noKube, "POST", "/v1/databases/x", "alice", {})).status).toBe(501);
  await db2.destroy();
});

test("delete: a database tears down its CNPG objects (no orphan)", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  const ns = kube.dbApplies[0]!.namespace;
  expect((await call(app, "DELETE", "/v1/sites/billing", "alice")).status).toBe(200);
  expect(kube.dbDeletes).toContainEqual({ namespace: ns, name: "billing" });
  await db.destroy();
});

test("db:create — prod (no S3 endpoint) fails closed without an IRSA role, succeeds with one", async () => {
  const mkProd = async (extra: Record<string, string>) => {
    const d = await makeTestDb();
    const users = new UserStore(d);
    const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com", ...extra });
    const kube = new FakeKube();
    const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
    return { d, kube, app: createApp({ cfg, meta: new MetaStore(d), blob: new FakeBlob(), db: d, users, verifier, kube, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(d), audit: new AuditStore(d) }) };
  };
  // prod, no role → fail closed (501), no DB provisioned
  const a = await mkProd({});
  const r1 = await call(a.app, "POST", "/v1/databases/billing", "alice", {});
  expect(r1.status).toBe(501);
  expect(a.kube.dbApplies).toHaveLength(0);
  await a.d.destroy();
  // prod, with IRSA role → success; manifest uses IRSA (no static creds Secret, SA annotated)
  const b = await mkProd({ DROP_DB_BACKUP_ROLE_ARN: "arn:aws:iam::1:role/drop-db" });
  const r2 = await call(b.app, "POST", "/v1/databases/billing", "alice", {});
  expect(r2.status).toBe(200);
  const m = b.kube.dbApplies[0]!.manifests;
  expect(m.secret).toBeUndefined();
  expect((m.objectStore as any).spec.configuration.s3Credentials.inheritFromIAMRole).toBe(true);
  expect((m.cluster as any).spec.serviceAccountTemplate.metadata.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::1:role/drop-db");
  await b.d.destroy();
});

test("transfer: a database is rejected (409) — stateful, can't be moved by a metadata flip", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/databases/billing", "alice", {});
  const res = await call(app, "POST", "/v1/sites/billing/transfer", "alice", { email: "bob@example.com" });
  expect(res.status).toBe(409);
  expect(kube.dbDeletes).toHaveLength(0); // nothing torn down — DB stays put with alice
  await db.destroy();
});

// ---- Phase D1: read-model (type everywhere) + per-type live detail + admin filters + suspension ----

test("db password --set-secret: rotates + stores as the app secret, never returned (--show opts in)", async () => {
  const { app, secrets, meta, db } = await mk();
  await call(app, "POST", "/v1/apps/blog", "alice", { image: "x:1" });
  await call(app, "POST", "/v1/databases/blog-db", "alice", {});
  // rotate + store directly into blog:PGPASSWORD — the plaintext is NOT returned to the client
  const j = await (await call(app, "POST", "/v1/databases/blog-db/password", "alice", { setSecret: { app: "blog", key: "PGPASSWORD" } })).json();
  expect(j.password).toBeUndefined();
  expect(j.secretSet).toMatchObject({ app: "blog", key: "PGPASSWORD" });
  expect([...secrets.values.values()].some((bag) => bag.has("PGPASSWORD"))).toBe(true); // actually stored in the backend
  expect((await meta.listSecretKeys("blog")).map((k: any) => k.key)).toContain("PGPASSWORD"); // + registered

  // --show opts into returning it as well
  const shown = await (await call(app, "POST", "/v1/databases/blog-db/password", "alice", { setSecret: { app: "blog", key: "PGPASSWORD" }, show: true })).json();
  expect(typeof shown.password).toBe("string");
  expect(shown.password.length).toBeGreaterThan(0);

  // target is validated BEFORE rotating: unknown app → 404, bad key → 400
  expect((await call(app, "POST", "/v1/databases/blog-db/password", "alice", { setSecret: { app: "ghost", key: "PGPASSWORD" } })).status).toBe(404);
  expect((await call(app, "POST", "/v1/databases/blog-db/password", "alice", { setSecret: { app: "blog", key: "bad key!" } })).status).toBe(400);
  await db.destroy();
});

test("ls ?org=<slug>: filters workloads to one org (members only)", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  await call(app, "POST", "/v1/apps/personalapp", "alice", { image: "x:1" }); // personal org
  await call(app, "POST", "/v1/apps/acmeapp?org=acme", "alice", { image: "x:1" }); // team org
  const all = (await (await call(app, "GET", "/v1/sites", "alice")).json()).sites.map((s: any) => s.name).sort();
  expect(all).toEqual(["acmeapp", "personalapp"]);
  const acme = (await (await call(app, "GET", "/v1/sites?org=acme", "alice")).json()).sites.map((s: any) => s.name);
  expect(acme).toEqual(["acmeapp"]);
  expect((await call(app, "GET", "/v1/sites?org=ghost", "alice")).status).toBe(404); // unknown org
  expect((await call(app, "GET", "/v1/sites?org=acme", "bob")).status).toBe(403); // not a member
  await db.destroy();
});

test("transfer --org: re-homes a site into a team org; app tears down workload; db blocked; guards", async () => {
  const { app, orgs, meta, db } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  const acmeId = (await orgs.getOrgBySlug("acme"))!.id;
  // a SITE re-homes cleanly (no workload)
  await pub(app, "alice", "mysite", await tgz({ "index.html": "x" }));
  const rs = await (await call(app, "POST", "/v1/sites/mysite/transfer", "alice", { toOrg: "acme" })).json();
  expect(rs.org).toBe("acme");
  expect((await meta.getSitePlain("mysite"))!.orgId).toBe(acmeId);
  expect(rs.secretsDropped).toBe(false);
  // an APP: workload + secrets torn down (owner redeploys into the new org)
  await call(app, "POST", "/v1/apps/myapp", "alice", { image: "x:1" });
  const ra = await (await call(app, "POST", "/v1/sites/myapp/transfer", "alice", { toOrg: "acme" })).json();
  expect(ra.org).toBe("acme");
  expect(ra.secretsDropped).toBe(true);
  expect((await meta.getSitePlain("myapp"))!.orgId).toBe(acmeId);
  // already in that org → 409
  expect((await call(app, "POST", "/v1/sites/mysite/transfer", "alice", { toOrg: "acme" })).status).toBe(409);
  // databases are blocked (stateful)
  await call(app, "POST", "/v1/databases/mydb", "alice", {});
  expect((await call(app, "POST", "/v1/sites/mydb/transfer", "alice", { toOrg: "acme" })).status).toBe(409);
  // can't dump into an org you're not a member of
  await call(app, "POST", "/v1/orgs", "bob", { slug: "other", name: "Other" });
  await call(app, "POST", "/v1/apps/app2", "alice", { image: "x:1" });
  expect((await call(app, "POST", "/v1/sites/app2/transfer", "alice", { toOrg: "other" })).status).toBe(403);
  await db.destroy();
});

test("/version is public and reports the served CLI version", async () => {
  const { app, db } = await mk();
  const res = await app.request("/version"); // no auth header — public, so `drop update` can read it
  expect(res.status).toBe(200);
  expect(((await res.json()) as { version: string }).version).toBe("dev"); // unbundled (test) build → "dev"
  await db.destroy();
});

test("read-model: list + detail + admin all carry the workload `type`", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await pub(app, "alice", "mysite", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/apps/myapp", "alice", { image: "x:1" });
  const list = await (await call(app, "GET", "/v1/sites", "alice")).json();
  const byName = Object.fromEntries(list.sites.map((s: any) => [s.name, s.type]));
  expect(byName.mysite).toBe("site");
  expect(byName.myapp).toBe("app");
  // each workload carries its owning org (slug/name/kind) for the console/CLI to display
  const myapp = list.sites.find((s: any) => s.name === "myapp");
  expect(myapp.org).toMatchObject({ kind: "personal", name: "alice@example.com" });
  expect(typeof myapp.org.slug).toBe("string");
  const detail = await (await call(app, "GET", "/v1/sites/myapp", "alice")).json();
  expect(detail.type).toBe("app");
  expect(detail.org).toMatchObject({ kind: "personal", name: "alice@example.com" });
  const admin = await (await call(app, "GET", "/v1/admin/sites", "alice")).json();
  expect(admin.sites.every((s: any) => typeof s.type === "string")).toBe(true);
  expect(admin.sites.every((s: any) => s.org && typeof s.org.slug === "string")).toBe(true);
  await db.destroy();
});

test("app detail: GET /v1/sites/:name returns image/scale + live status", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "ecr/billing:v2", scale: { min: 0, max: 3 } });
  const j = await (await call(app, "GET", "/v1/sites/billing", "alice")).json();
  expect(j.type).toBe("app");
  expect(j.app.image).toBe("ecr/billing:v2");
  expect(j.app.scale).toEqual({ min: 0, max: 3 });
  expect(j.app.status).toEqual({ replicas: 1, ready: 1, restarts: 0, reason: "Running" }); // FakeKube healthy default
  await db.destroy();
});

test("app detail surfaces crash diagnostics (restarts + reason); logs endpoint returns recent logs", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const ns = kube.applies[0]!.namespace;
  // simulate a crash-looping app + some logs
  kube.statusOverride.set(`${ns}/billing`, { replicas: 1, ready: 0, restarts: 7, reason: "CrashLoopBackOff" } as any);
  kube.logsByName.set(`${ns}/billing`, "todo: DB not ready (attempt 3): FailedToOpenSocket\n");
  const detail = await (await call(app, "GET", "/v1/sites/billing", "alice")).json();
  expect(detail.app.status).toEqual({ replicas: 1, ready: 0, restarts: 7, reason: "CrashLoopBackOff" });
  const logs = await (await call(app, "GET", "/v1/sites/billing/logs", "alice")).json();
  expect(logs.logs).toContain("FailedToOpenSocket");
  // a static site has no pods → empty logs, no error
  await pub(app, "alice", "asite", await tgz({ "index.html": "x" }));
  expect((await (await call(app, "GET", "/v1/sites/asite/logs", "alice")).json()).logs).toBe("");
  await db.destroy();
});

test("logs endpoint is gated above viewer (viewer 403 — logs may leak secrets; editor 200)", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const ns = kube.applies[0]!.namespace;
  kube.logsByName.set(`${ns}/billing`, "boot env: DATABASE_URL=postgres://app:s3cr3t@db\n");
  // bob as VIEWER: can read metadata, but NOT logs (a viewer is metadata-only)
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  expect((await call(app, "GET", "/v1/sites/billing", "bob")).status).toBe(200);
  expect((await call(app, "GET", "/v1/sites/billing/logs", "bob")).status).toBe(403);
  // promote to EDITOR → logs allowed
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  expect((await call(app, "GET", "/v1/sites/billing/logs", "bob")).status).toBe(200);
  await db.destroy();
});

// ---- G4: historical log search over the retained S3 objects ----

// Seed a retained log object (gzipped NDJSON) + its index row so the search route has something to read.
async function seedLogObject(meta: MetaStore, blob: FakeBlob, site: string, hour: string, records: LogRecord[]) {
  const key = logObjectKey(site, new Date(hour));
  const bytes = serializeNdjsonGz(records);
  await blob.put(key, bytes, bytes.byteLength, "application/gzip");
  await meta.insertLogObject({ siteName: site, hour: new Date(hour), key, lines: records.length, bytes: bytes.byteLength });
}

test("GET /v1/sites/:name/logs/search: time-range + substring match over indexed objects, capped/truncated", async () => {
  const { app, meta, blob, db } = await mk();
  await call(app, "POST", "/v1/apps/logsearch", "alice", { image: "x:1" });
  const rec = (ts: string, line: string): LogRecord => ({ ts, site: "logsearch", pod: "logsearch", stream: "stdout", line });
  await seedLogObject(meta, blob, "logsearch", "2026-07-04T09:00:00Z", [rec("2026-07-04T09:10:00Z", "GET /a 200"), rec("2026-07-04T09:20:00Z", "ERROR boom")]);
  await seedLogObject(meta, blob, "logsearch", "2026-07-04T10:00:00Z", [rec("2026-07-04T10:05:00Z", "GET /b 200"), rec("2026-07-04T10:30:00Z", "ERROR kaboom")]);

  // substring q=ERROR across the whole day → newest object first
  const r = await call(app, "GET", "/v1/sites/logsearch/logs/search?from=2026-07-04T00:00:00Z&to=2026-07-04T23:00:00Z&q=ERROR", "alice");
  expect(r.status).toBe(200);
  const j = (await r.json()) as { lines: { line: string }[]; truncated: boolean; scanned: number };
  expect(j.lines.map((l) => l.line)).toEqual(["ERROR kaboom", "ERROR boom"]);
  expect(j.truncated).toBe(false);
  expect(j.scanned).toBe(2);

  // time range narrows to the hour-10 object only
  const r2 = await call(app, "GET", "/v1/sites/logsearch/logs/search?from=2026-07-04T10:00:00Z&to=2026-07-04T11:00:00Z&q=", "alice");
  expect(((await r2.json()) as { lines: { line: string }[] }).lines.map((l) => l.line)).toEqual(["GET /b 200", "ERROR kaboom"]);

  // cap → truncated flag
  const r3 = await call(app, "GET", "/v1/sites/logsearch/logs/search?from=2026-07-04T00:00:00Z&to=2026-07-04T23:00:00Z&q=&limit=1", "alice");
  const j3 = (await r3.json()) as { lines: unknown[]; truncated: boolean };
  expect(j3.lines).toHaveLength(1);
  expect(j3.truncated).toBe(true);
  await db.destroy();
});

test("GET /v1/sites/:name/logs/search is gated like live logs (viewer 403; editor 200) and 400s a bad regex / range", async () => {
  const { app, meta, blob, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  await seedLogObject(meta, blob, "billing", "2026-07-04T10:00:00Z", [{ ts: "2026-07-04T10:05:00Z", site: "billing", pod: "billing", stream: "stdout", line: "hello" }]);
  // viewer: metadata-only — retained logs can leak env-injected secrets, same gate as the live tail
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  expect((await call(app, "GET", "/v1/sites/billing/logs/search?q=hello", "bob")).status).toBe(403);
  await call(app, "POST", "/v1/sites/billing/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  expect((await call(app, "GET", "/v1/sites/billing/logs/search?q=hello", "bob")).status).toBe(200);
  // a bad regex → 400 (not a 500)
  expect((await call(app, "GET", "/v1/sites/billing/logs/search?q=(&regex=1", "alice")).status).toBe(400);
  // from > to → 400
  expect((await call(app, "GET", "/v1/sites/billing/logs/search?from=2026-07-04T11:00:00Z&to=2026-07-04T10:00:00Z", "alice")).status).toBe(400);
  // unknown site → 404
  expect((await call(app, "GET", "/v1/sites/nope/logs/search?q=x", "alice")).status).toBe(404);
  await db.destroy();
});

test("database detail: GET /v1/sites/:name returns connection ref (no password) + live status", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/databases/bills", "alice", {});
  const j = await (await call(app, "GET", "/v1/sites/bills", "alice")).json();
  expect(j.type).toBe("database");
  expect(j.database.port).toBe(5432);
  expect(j.database.database).toBe("app");
  expect(j.database.user).toBe("app"); // the connection username is surfaced (password still never is)
  expect(j.database.credentialsSecret).toBe("bills-app");
  expect(j.database.host).toMatch(/^bills-rw\.drop-t-/);
  expect(j.database.status.phase).toBe("Cluster in healthy state");
  expect(JSON.stringify(j)).not.toContain("password");
  await db.destroy();
});

test("admin filters: ?type= and ?owner= narrow the catalog", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await pub(app, "alice", "asite", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/apps/anapp", "alice", { image: "x:1" });
  await call(app, "POST", "/v1/databases/bobdb", "bob", {});
  const apps = await (await call(app, "GET", "/v1/admin/sites?type=app", "alice")).json();
  expect(apps.sites.map((s: any) => s.name)).toEqual(["anapp"]);
  const bobs = await (await call(app, "GET", "/v1/admin/sites?owner=bob@example.com", "alice")).json();
  expect(bobs.sites.map((s: any) => s.name)).toEqual(["bobdb"]);
  await db.destroy();
});

test("suspension: a suspended user is blocked (403); admin can suspend + reactivate; no self-lockout", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await pub(app, "bob", "bobsite", await tgz({ "index.html": "x" })); // bob acts → registered in users
  // alice (admin) suspends bob → bob is blocked on every /v1 route
  expect((await call(app, "POST", "/v1/admin/users/bob@example.com/status", "alice", { status: "suspended" })).status).toBe(200);
  expect((await call(app, "GET", "/v1/me", "bob")).status).toBe(403);
  expect((await call(app, "POST", "/v1/apps/x", "bob", { image: "x:1" })).status).toBe(403);
  // reactivate → bob works again
  await call(app, "POST", "/v1/admin/users/bob@example.com/status", "alice", { status: "active" });
  expect((await call(app, "GET", "/v1/me", "bob")).status).toBe(200);
  // non-admin can't suspend; admin can't lock themselves out
  expect((await call(app, "POST", "/v1/admin/users/alice@example.com/status", "bob", { status: "suspended" })).status).toBe(403);
  expect((await call(app, "POST", "/v1/admin/users/alice@example.com/status", "alice", { status: "suspended" })).status).toBe(400);
  await db.destroy();
});

test("suspension: an admin cannot suspend another admin (409), but can reactivate", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com", "bob@example.com"] });
  await pub(app, "bob", "bobsite", await tgz({ "index.html": "x" })); // bob registered (seeded admin)
  expect((await call(app, "POST", "/v1/admin/users/bob@example.com/status", "alice", { status: "suspended" })).status).toBe(409);
  expect((await call(app, "POST", "/v1/admin/users/bob@example.com/status", "alice", { status: "active" })).status).toBe(200);
  await db.destroy();
});

test("deploy: tenant egress except is sourced from config (DROP_BLOCKED_EGRESS_CIDRS)", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const meta = new MetaStore(db);
  const kube = new FakeKube();
  const cfg = loadConfig({
    DROP_S3_BUCKET: "b",
    DROP_DATABASE_URL: "postgres://x/y",
    DROP_BASE_DOMAIN: "drop.example.com",
    DROP_BLOCKED_EGRESS_CIDRS: "100.64.0.0/10,172.16.0.0/12",
  });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, kube, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(db), audit: new AuditStore(db) });
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const np = kube.tenantApplies[0]!.manifests.networkPolicy as any;
  const https = np.spec.egress.find((e: any) => (e.ports ?? []).some((p: any) => p.port === 443));
  expect(https.to[0].ipBlock.except).toEqual(["169.254.169.254/32", "100.64.0.0/10", "172.16.0.0/12"]);
  await db.destroy();
});

// ---- Feature 6: runtime user/role management ----
test("admin: list users + grant/revoke platform-admin role", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  // bob registers (first /v1 touch provisions the user)
  await call(app, "GET", "/v1/me", "bob");
  // non-admin can't list users
  expect((await call(app, "GET", "/v1/admin/users", "bob")).status).toBe(403);
  // admin lists users → alice (admin) + bob (member) present
  const list = await (await call(app, "GET", "/v1/admin/users", "alice")).json();
  const roles = Object.fromEntries(list.users.map((u: any) => [u.email, u.role]));
  expect(roles["alice@example.com"]).toBe("admin");
  expect(roles["bob@example.com"]).toBe("member");
  // alice promotes bob → admin; now bob can list users
  expect((await call(app, "POST", "/v1/admin/users/bob@example.com/role", "alice", { role: "admin" })).status).toBe(200);
  expect((await call(app, "GET", "/v1/admin/users", "bob")).status).toBe(200);
  // alice demotes bob → member; bob loses admin
  expect((await call(app, "POST", "/v1/admin/users/bob@example.com/role", "alice", { role: "member" })).status).toBe(200);
  expect((await call(app, "GET", "/v1/admin/users", "bob")).status).toBe(403);
  await db.destroy();
});

test("admin role: guards (own role, bad role, unknown user, non-admin)", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await call(app, "GET", "/v1/me", "bob");
  // can't change your own role (no self-lockout)
  expect((await call(app, "POST", "/v1/admin/users/alice@example.com/role", "alice", { role: "member" })).status).toBe(400);
  // bad role value
  expect((await call(app, "POST", "/v1/admin/users/bob@example.com/role", "alice", { role: "superuser" })).status).toBe(400);
  // unknown user
  expect((await call(app, "POST", "/v1/admin/users/nobody@example.com/role", "alice", { role: "admin" })).status).toBe(404);
  // non-admin can't set roles
  expect((await call(app, "POST", "/v1/admin/users/alice@example.com/role", "bob", { role: "member" })).status).toBe(403);
  await db.destroy();
});

// ---- Feature 5: audit log ----
test("audit: mutating + admin actions are recorded; admin can read the trail", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await pub(app, "alice", "blog", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/sites/blog/visibility", "alice", { visibility: "private" });
  await call(app, "POST", "/v1/sites/blog/collaborators", "alice", { email: "bob@example.com" });
  expect((await call(app, "DELETE", "/v1/sites/blog", "alice")).status).toBe(200);
  // non-admin can't read the trail
  expect((await call(app, "GET", "/v1/admin/audit", "bob")).status).toBe(403);
  const trail = await (await call(app, "GET", "/v1/admin/audit", "alice")).json();
  const actions = trail.entries.map((e: any) => e.action);
  expect(actions).toContain("site.delete");
  expect(actions).toContain("site.visibility.set");
  expect(actions).toContain("site.collaborator.add");
  // delete entry carries structured detail + target
  const del = trail.entries.find((e: any) => e.action === "site.delete");
  expect(del.target).toBe("blog");
  expect(del.actor).toBe("alice@example.com");
  await db.destroy();
});

test("audit: role change is recorded with detail + filterable by action", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await call(app, "GET", "/v1/me", "bob");
  await call(app, "POST", "/v1/admin/users/bob@example.com/role", "alice", { role: "admin" });
  const filtered = await (await call(app, "GET", "/v1/admin/audit?action=user.role.set", "alice")).json();
  expect(filtered.entries.length).toBe(1);
  expect(filtered.entries[0].target).toBe("bob@example.com");
  expect(filtered.entries[0].detail.role).toBe("admin");
  await db.destroy();
});

test("audit: db password rotation is recorded without the password", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/databases/pg1", "alice", {});
  await call(app, "POST", "/v1/databases/pg1/password", "alice", {});
  // make alice a platform admin so she can read the trail
  await db.updateTable("users").set({ role: "admin" }).where("email", "=", "alice@example.com").execute();
  const trail = await (await call(app, "GET", "/v1/admin/audit?action=db.password.rotate", "alice")).json();
  expect(trail.entries.length).toBe(1);
  expect(JSON.stringify(trail.entries[0])).not.toContain("password\":\"");
  await db.destroy();
});

// ---- Feature 4: usage metering + per-tenant cap ----
const personalSlug = async (app: any, tok: string): Promise<string> => {
  const r = await (await call(app, "GET", "/v1/orgs", tok)).json();
  return r.orgs.find((o: any) => o.kind === "personal").slug;
};

test("usage: workload counts + cap + cluster quota for an org", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "blog", await tgz({ "index.html": "x" })); // site
  await call(app, "POST", "/v1/apps/api1", "alice", { image: "x:1" }); // app (applies tenant → quota)
  await call(app, "POST", "/v1/databases/pg1", "alice", {}); // database
  const slug = await personalSlug(app, "alice");
  const u = await (await call(app, "GET", `/v1/orgs/${slug}/usage`, "alice")).json();
  expect(u.workloads).toEqual({ site: 1, app: 1, database: 1, bucket: 0, cache: 0, auth: 0, total: 3 });
  expect(u.cap).toBe(0); // unlimited by default
  expect(u.quota.hard["count/pods"]).toBe("20"); // FakeKube default quota
  await db.destroy();
});

test("usage: non-member is forbidden", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/api1", "alice", { image: "x:1" });
  const slug = await personalSlug(app, "alice");
  expect((await call(app, "GET", `/v1/orgs/${slug}/usage`, "bob")).status).toBe(403);
  await db.destroy();
});

test("cap: DROP_MAX_WORKLOADS_PER_ORG blocks claiming beyond the limit (429); re-deploy is exempt", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const meta = new MetaStore(db);
  const kube = new FakeKube();
  const cfg = loadConfig({
    DROP_S3_BUCKET: "b",
    DROP_DATABASE_URL: "postgres://x/y",
    DROP_BASE_DOMAIN: "drop.example.com",
    DROP_S3_ENDPOINT: "http://localhost:4566",
    DROP_MAX_WORKLOADS_PER_ORG: "2",
  });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, kube, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(db), audit: new AuditStore(db) });
  expect((await call(app, "POST", "/v1/apps/a1", "alice", { image: "x:1" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/a2", "alice", { image: "x:1" })).status).toBe(200);
  // third NEW name is over the cap
  const over = await call(app, "POST", "/v1/apps/a3", "alice", { image: "x:1" });
  expect(over.status).toBe(429);
  // re-deploying an EXISTING workload is never capped
  expect((await call(app, "POST", "/v1/apps/a1", "alice", { image: "x:2" })).status).toBe(200);
  await db.destroy();
});

// ---- Feature 3: backups + hibernate/wake ----
test("db backups: trigger creates a Backup; list surfaces last success; audited", async () => {
  const { app, kube, db } = await mk({ admins: ["alice@example.com"] });
  await call(app, "POST", "/v1/databases/pg1", "alice", {});
  const ns = kube.dbApplies[0]!.namespace;
  // preset a completed backup so list reports lastSuccessAt
  kube.backupsByDb.set(`${ns}/pg1`, [{ name: "pg1-daily-1", phase: "completed", method: "plugin", startedAt: "2026-06-01T02:00:00Z", stoppedAt: "2026-06-01T02:01:00Z", error: null }]);
  const list = await (await call(app, "GET", "/v1/databases/pg1/backups", "alice")).json();
  expect(list.backups.length).toBe(1);
  expect(list.lastSuccessAt).toBe("2026-06-01T02:01:00Z");
  // trigger on-demand
  const t = await (await call(app, "POST", "/v1/databases/pg1/backups", "alice")).json();
  expect(t.started).toBe(true);
  expect(kube.backupTriggers[0]!.name).toBe("pg1");
  expect(kube.backupTriggers[0]!.backupName).toMatch(/^pg1-ob-[a-z0-9]+$/); // DNS-safe
  // audited
  const trail = await (await call(app, "GET", "/v1/admin/audit?action=db.backup.trigger", "alice")).json();
  expect(trail.entries.length).toBe(1);
  await db.destroy();
});

test("db hibernate/wake toggles cluster state + is gated at editor+", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/databases/pg1", "alice", {});
  const ns = kube.dbApplies[0]!.namespace;
  expect((await call(app, "POST", "/v1/databases/pg1/hibernate", "alice")).status).toBe(200);
  expect(kube.hibernated.has(`${ns}/pg1`)).toBe(true);
  // a viewer collaborator cannot hibernate
  await call(app, "POST", "/v1/sites/pg1/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  expect((await call(app, "POST", "/v1/databases/pg1/wake", "bob")).status).toBe(403);
  // owner wakes
  expect((await call(app, "POST", "/v1/databases/pg1/wake", "alice")).status).toBe(200);
  expect(kube.hibernated.has(`${ns}/pg1`)).toBe(false);
  await db.destroy();
});

test("db backups: not-a-database is 409, unknown is 404", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/anapp", "alice", { image: "x:1" });
  expect((await call(app, "GET", "/v1/databases/anapp/backups", "alice")).status).toBe(409);
  expect((await call(app, "GET", "/v1/databases/ghost/backups", "alice")).status).toBe(404);
  await db.destroy();
});

// ---- admin: org picker + per-org resource browse ----
test("admin: list all orgs + filter admin/sites by org", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] }); // alice = platform admin
  // alice creates a team org and deploys into it (+ one in her personal org); bob has only a site
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  await call(app, "POST", "/v1/apps/acme-api", "alice", { image: "x:1" }); // alice personal org
  await call(app, "POST", "/v1/apps/acme-web?org=acme", "alice", { image: "x:1" }); // acme org
  await call(app, "POST", "/v1/databases/acme-db?org=acme", "alice", {}); // acme org
  await pub(app, "bob", "bobsite", await tgz({ "index.html": "x" }));
  // non-admin (bob) can't list all orgs
  expect((await call(app, "GET", "/v1/admin/orgs", "bob")).status).toBe(403);
  // admin sees every org (personal + team), team first
  const orgs = (await (await call(app, "GET", "/v1/admin/orgs", "alice")).json()).orgs;
  const slugs = orgs.map((o: any) => o.slug);
  expect(slugs).toContain("acme");
  expect(orgs.find((o: any) => o.slug === "acme").kind).toBe("team");
  expect(orgs.some((o: any) => o.kind === "personal")).toBe(true);
  // filter admin/sites by org=acme → only the two acme resources (grouped client-side into the grid)
  const acme = (await (await call(app, "GET", "/v1/admin/sites?org=acme", "alice")).json()).sites;
  expect(acme.map((s: any) => s.name).sort()).toEqual(["acme-db", "acme-web"]);
  expect(acme.every((s: any) => s.org.slug === "acme")).toBe(true);
  // unknown org slug → empty page
  expect((await (await call(app, "GET", "/v1/admin/sites?org=nope", "alice")).json()).sites).toEqual([]);
  await db.destroy();
});

// ================================ Stacks (B2): declarative `drop up` ================================
const shopSpec = {
  name: "shop",
  resources: {
    db: { type: "database", storage: "1Gi" },
    api: { type: "app", uses: [{ database: "db" }] },
    web: { type: "site" },
  },
};

test("stack up dry-run returns the ordered plan + needs + outputs and applies NOTHING", async () => {
  const { app, kube, db } = await mk();
  const spec = {
    name: "shop",
    resources: {
      db: { type: "database" },
      api: { type: "app", dir: "./api", uses: [{ database: "db" }] },
      web: { type: "site", dir: "./web", env_from: [{ resource: "api", output: "url", as: "API_BASE" }] },
    },
  };
  const res = await call(app, "POST", "/v1/stacks/shop/up?dry_run=1", "alice", { spec });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.dryRun).toBe(true);
  expect(body.plan.map((s: any) => [s.action, s.key, s.siteName])).toEqual([
    ["create", "db", "shop-db"],
    ["create", "api", "shop-api"],
    ["create", "web", "shop-web"],
  ]);
  // needs: the api image must be built (dir + no image), the web bytes published (dir)
  expect(body.needs).toContainEqual({ key: "api", kind: "app-image", siteName: "shop-api" });
  expect(body.needs).toContainEqual({ key: "web", kind: "site-publish", siteName: "shop-web" });
  // outputs carry the app URL for env_from substitution (done CLI-side)
  expect(body.outputs.api.url).toBe("https://shop-api.drop.example.com");
  // nothing hit the cluster, and no stack row was created
  expect(kube.applies.length).toBe(0);
  expect(kube.dbApplies.length).toBe(0);
  expect((await call(app, "GET", "/v1/stacks/shop", "alice")).status).toBe(404);
  await db.destroy();
});

test("stack up creates a db + app + site, wires the uses edge, and re-runs as all-noop", async () => {
  const { app, kube, meta, db } = await mk();
  const res = await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: shopSpec, resolved: { api: { image: "api:1" } } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.specVersion).toBe(1);
  expect(body.plan.map((s: any) => [s.action, s.key])).toEqual([["create", "db"], ["create", "api"], ["create", "web"]]);
  // FakeKube saw the db + the app
  expect(kube.dbApplies.some((a) => a.name === "shop-db")).toBe(true);
  expect(kube.applies.some((a) => a.name === "shop-api")).toBe(true);
  // the app's uses:[{database:db}] resolved to the materialized DB name and wired the B1 binding
  const applied = kube.applies.find((a) => a.name === "shop-api")!.manifests;
  const ctr = (applied.deployment as any).spec.template.spec.containers[0];
  expect(ctr.envFrom[0]).toEqual({ secretRef: { name: "shop-db-app" } });
  // resources are ordinary rows of the right type
  expect((await meta.getSitePlain("shop-db"))!.type).toBe("database");
  expect((await meta.getSitePlain("shop-api"))!.type).toBe("app");
  expect((await meta.getSitePlain("shop-web"))!.type).toBe("site");
  // status endpoint reflects the three resources
  const status = await (await call(app, "GET", "/v1/stacks/shop", "alice")).json();
  expect(status.resources.map((r: any) => r.key).sort()).toEqual(["api", "db", "web"]);
  expect(status.specVersion).toBe(1);
  // an idempotent re-run converges to all-noop (config unchanged) and bumps the version
  const res2 = await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: shopSpec, resolved: { api: { image: "api:1" } }, spec_version: 1 });
  expect(res2.status).toBe(200);
  const body2 = await res2.json();
  expect(body2.plan.every((s: any) => s.action === "noop")).toBe(true);
  expect(body2.specVersion).toBe(2);
  await db.destroy();
});

test("H3 stack up: app→app uses injects <KEY>_URL (svc for always-on, public host for scale-to-zero); ordered target-first", async () => {
  const { app, kube, meta, db } = await mk();
  const spec = {
    name: "svc",
    resources: {
      hot: { type: "app", scale: { min: 1, max: 3 } }, // always-on target
      cold: { type: "app" }, // default scale {min:0} → scale-to-zero target
      web: { type: "app", uses: [{ app: "hot" }, { app: "cold" }] },
    },
  };
  const res = await call(app, "POST", "/v1/stacks/svc/up", "alice", {
    spec,
    resolved: { hot: { image: "h:1" }, cold: { image: "c:1" }, web: { image: "w:1" } },
  });
  expect(res.status).toBe(200);
  // web depends on both peers → they are created BEFORE it (topo order)
  const order = (await res.json()).plan.map((s: any) => s.key);
  expect(order.indexOf("web")).toBeGreaterThan(order.indexOf("hot"));
  expect(order.indexOf("web")).toBeGreaterThan(order.indexOf("cold"));
  const ns = (await meta.getSitePlain("svc-web"))!.namespace;
  const ctr = (kube.applies.find((a) => a.name === "svc-web")!.manifests.deployment as any).spec.template.spec.containers[0];
  expect(ctr.env).toContainEqual({ name: "HOT_URL", value: `http://svc-hot.${ns}.svc.cluster.local:80` });
  expect(ctr.env).toContainEqual({ name: "COLD_URL", value: "https://svc-cold.drop.example.com" });
  // the graph edge is rendered with the concrete injected env var
  const graph = await (await call(app, "GET", "/v1/stacks/svc/graph", "alice")).json();
  expect(graph.edges).toContainEqual({ from: "hot", to: "web", kind: "uses", label: "injects HOT_URL" });
  await db.destroy();
});

test("stack up: stale spec_version → 409", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: { name: "shop", resources: { db: { type: "database" } } } });
  const res = await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: { name: "shop", resources: { db: { type: "database" } } }, spec_version: 99 });
  expect(res.status).toBe(409);
  await db.destroy();
});

test("stack up: lock contention → 409", async () => {
  const { app, db, orgs, locks, users } = await mk();
  await users.upsertOnLogin("alice@example.com", null); // provision the user (FK) before touching orgs
  const org = await orgs.ensurePersonalOrg("alice@example.com");
  const id = new StackStore(db).stackId(org.id, "shop");
  expect(await locks.acquire(`stack:${id}`, "someone-else", 60_000)).toBe(true); // hold it
  const res = await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: { name: "shop", resources: { db: { type: "database" } } } });
  expect(res.status).toBe(409);
  await db.destroy();
});

test("stack up: a resource name owned by another org → 409 cross-org conflict", async () => {
  const { app, db } = await mk();
  // alice owns a database literally named "shop-db" (in her personal org)
  expect((await call(app, "POST", "/v1/databases/shop-db", "alice", {})).status).toBe(200);
  // bob's stack "shop" would materialize db → "shop-db", which belongs to alice's org
  const res = await call(app, "POST", "/v1/stacks/shop/up", "bob", { spec: { name: "shop", resources: { db: { type: "database" } } } });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("another organisation");
  await db.destroy();
});

test("stack delete: orphan leaves resources; cascade tears them down; both audited", async () => {
  const { app, kube, meta, audit, db } = await mk();
  // orphan case
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: shopSpec, resolved: { api: { image: "api:1" } } });
  const orphan = await call(app, "DELETE", "/v1/stacks/shop", "alice");
  expect(orphan.status).toBe(200);
  const ob = await orphan.json();
  expect(ob.cascade).toBe(false);
  expect(ob.resources.every((r: any) => r.action === "orphaned")).toBe(true);
  expect(await meta.getSitePlain("shop-db")).not.toBeNull(); // still there
  expect((await call(app, "GET", "/v1/stacks/shop", "alice")).status).toBe(404); // stack gone

  // cascade case (fresh stack)
  await call(app, "POST", "/v1/stacks/prod/up", "alice", {
    spec: { name: "prod", resources: { db: { type: "database" }, api: { type: "app", uses: [{ database: "db" }] } } },
    resolved: { api: { image: "api:1" } },
  });
  const casc = await call(app, "DELETE", "/v1/stacks/prod?cascade=1", "alice");
  expect(casc.status).toBe(200);
  const cb = await casc.json();
  expect(cb.cascade).toBe(true);
  expect(cb.resources.find((r: any) => r.siteName === "prod-db").action).toBe("deleted");
  expect(kube.dbDeletes.some((d) => d.name === "prod-db")).toBe(true);
  expect(kube.deletes.some((d) => d.name === "prod-api")).toBe(true);
  expect(await meta.getSitePlain("prod-db")).toBeNull();

  // audit trail carries stack.up (x2) and stack.delete (x2)
  const rows = await audit.list({});
  expect(rows.entries.filter((e) => e.action === "stack.up").length).toBeGreaterThanOrEqual(2);
  expect(rows.entries.filter((e) => e.action === "stack.delete").length).toBe(2);
  await db.destroy();
});

test("stack up: a cross-stack edge cycle is rejected with 400; a bad edge target is 400", async () => {
  const { app, db } = await mk();
  // bad edge target: app uses a db key that isn't a resource
  const bad = await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: { name: "shop", resources: { api: { type: "app", image: "x:1", uses: [{ database: "ghost" }] } } } });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("ghost");
  await db.destroy();
});

test("stack up: a non-member cannot reconcile into another org's stack", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  // bob is not a member of acme → cannot create a stack there
  const res = await call(app, "POST", "/v1/stacks/shop/up?org=acme", "bob", { spec: { name: "shop", resources: { db: { type: "database" } } } });
  expect(res.status).toBe(403);
  await db.destroy();
});

test("stack ls lists the caller's stacks across orgs", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: { name: "shop", resources: { db: { type: "database" } } } });
  const list = await (await call(app, "GET", "/v1/stacks", "alice")).json();
  expect(list.stacks.map((s: any) => s.name)).toContain("shop");
  expect(list.stacks.find((s: any) => s.name === "shop").resources).toBe(1);
  // bob sees none
  expect((await (await call(app, "GET", "/v1/stacks", "bob")).json()).stacks).toEqual([]);
  await db.destroy();
});

// ---- C1: GET /v1/stacks/:name/graph ----

const graphSpec = {
  name: "shop",
  resources: {
    db: { type: "database", storage: "1Gi" },
    api: { type: "app", uses: [{ database: "db" }] },
    web: { type: "site", env_from: [{ resource: "api", output: "url", as: "API_BASE" }] },
  },
};

test("stack graph: nodes (live status via aggregated ns lists) + edges from spec", async () => {
  const { app, kube, meta, db } = await mk();
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: graphSpec, resolved: { api: { image: "api:1" } } });

  // A crash reason set on the app must surface through the ONE aggregated ns list (not a per-node call).
  const ns = (await meta.getSitePlain("shop-api"))!.namespace;
  kube.statusOverride.set(`${ns}/shop-api`, { replicas: 1, ready: 0, restarts: 5, reason: "CrashLoopBackOff" });

  const res = await call(app, "GET", "/v1/stacks/shop/graph", "alice");
  expect(res.status).toBe(200);
  const g = await res.json();

  // nodes: shape + normalized status per kind
  const byKey = Object.fromEntries(g.nodes.map((n: any) => [n.key, n]));
  expect(byKey.db).toMatchObject({ siteName: "shop-db", type: "database", url: "https://shop-db.drop.example.com", exists: true });
  expect(byKey.db.currentVersion).toBeTruthy();
  expect(byKey.db.status.status).toBe("running"); // FakeKube healthy CNPG default
  expect(byKey.web.status).toEqual({ status: "running", reason: "serving" }); // static site
  expect(byKey.api.status.status).toBe("error"); // the CrashLoopBackOff override came through the ns list
  expect(byKey.api.status.reason).toBe("CrashLoopBackOff");

  // edges straight from the spec, labeled (provider → consumer)
  expect(g.edges).toContainEqual({ from: "db", to: "api", kind: "uses", label: "PG* via shop-db-app" });
  expect(g.edges).toContainEqual({ from: "api", to: "web", kind: "env_from", label: "URL at publish" });
  await db.destroy();
});

test("stack graph ?include_plan: a resource deleted out-of-band shows as create-pending", async () => {
  const { app, meta, db } = await mk();
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: graphSpec, resolved: { api: { image: "api:1" } } });
  // delete the db's site row underneath the stack (drift)
  await meta.deleteSite("shop-db");

  const res = await call(app, "GET", "/v1/stacks/shop/graph?include_plan=1", "alice");
  expect(res.status).toBe(200);
  const g = await res.json();
  // the node now reports missing, and the overlay flags a pending create for it
  expect(g.nodes.find((n: any) => n.key === "db").exists).toBe(false);
  expect(g.plan).toContainEqual(expect.objectContaining({ action: "create", key: "db", siteName: "shop-db" }));
  // unchanged resources are NOT in the (noop-filtered) overlay
  expect(g.plan.some((s: any) => s.key === "api")).toBe(false);
  await db.destroy();
});

test("stack graph authz: 404 for an unknown stack, 403 for a non-member of the org", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  await call(app, "POST", "/v1/stacks/shop/up?org=acme", "alice", { spec: { name: "shop", resources: { db: { type: "database" } } } });

  expect((await call(app, "GET", "/v1/stacks/ghost/graph", "alice")).status).toBe(404);
  const forbidden = await call(app, "GET", "/v1/stacks/shop/graph?org=acme", "bob");
  expect(forbidden.status).toBe(403);
  await db.destroy();
});

test("stack graph: compute-off degrades statuses to the no-status outputs (endpoint still works)", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: graphSpec, resolved: { api: { image: "api:1" } } });

  // A second API instance over the SAME db with NO kube: the graph read must still succeed, statuses degraded.
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com", DROP_S3_ENDPOINT: "http://localhost:4566" });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const noKube = createApp({ cfg, meta: new MetaStore(db), blob: new FakeBlob(), db, users: new UserStore(db), verifier, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(db), audit: new AuditStore(db) });

  const res = await call(noKube, "GET", "/v1/stacks/shop/graph", "alice");
  expect(res.status).toBe(200);
  const byKey = Object.fromEntries((await res.json()).nodes.map((n: any) => [n.key, n]));
  expect(byKey.api.status).toEqual({ status: "progressing", reason: "status unavailable" });
  expect(byKey.db.status).toEqual({ status: "progressing", reason: "status unavailable" });
  expect(byKey.web.status).toEqual({ status: "running", reason: "serving" }); // sites never depend on kube
  await db.destroy();
});

// ============================ D1: template registry ============================
const widgetTpl = {
  name: "widget",
  resources: {
    db: { type: "database", storage: "1Gi" },
    web: {
      type: "app",
      image: "web:1",
      uses: [{ database: "db" }],
      env: { PGHOST: "${stack}-db-rw", SESSION_SECRET: "${var.session}" },
    },
  },
};
const sessionVar = [{ key: "session", description: "app session secret", required: true, secret: true }];

test("template publish → list → get → instantiate: provenance recorded, secretsToSet NOT in spec, audited", async () => {
  const { app, audit, db } = await mk();

  // publish (public); the strip pass sees no flags (SESSION_SECRET is variable-ized)
  const pub = await call(app, "POST", "/v1/templates", "alice", { slug: "widget", name: "Widget", visibility: "public", spec: widgetTpl, variables: sessionVar, readme: "# Widget\nA guestbook template." });
  expect(pub.status).toBe(200);
  expect((await pub.json()).version).toBe("1");

  // list (public → visible to everyone, incl. bob)
  const list = await (await call(app, "GET", "/v1/templates", "alice")).json();
  expect(list.templates.map((t: any) => t.slug)).toContain("widget");
  expect((await (await call(app, "GET", "/v1/templates", "bob")).json()).templates.map((t: any) => t.slug)).toContain("widget");

  // get: readme + variables + the template-relative spec (secret still declared, not yet resolved)
  const get = await (await call(app, "GET", "/v1/templates/widget", "alice")).json();
  expect(get.readme).toContain("Widget");
  expect(get.variables).toEqual(sessionVar);
  expect(get.spec.resources.web.env.SESSION_SECRET).toBe("${var.session}");

  // instantiate → new stack "shop"; runs the same up path
  const inst = await call(app, "POST", "/v1/templates/widget/instantiate", "alice", { name: "shop", vars: { session: "top-secret-value" } });
  expect(inst.status).toBe(200);
  const body = await inst.json();
  expect(body.stack).toBe("shop");
  expect(body.version).toBe("1");
  expect(body.plan.map((s: any) => [s.action, s.key])).toEqual([["create", "db"], ["create", "web"]]);
  // secretsToSet resolved to the materialized app name + carries the value the caller supplied
  expect(body.secretsToSet).toEqual([{ app: "shop-web", resourceKey: "web", key: "SESSION_SECRET", value: "top-secret-value" }]);

  // the applied stack spec has ${stack} resolved and the SECRET REMOVED, and records provenance
  const stack = await (await call(app, "GET", "/v1/stacks/shop", "alice")).json();
  expect(stack.spec.resources.web.env.PGHOST).toBe("shop-db-rw");
  expect(stack.spec.resources.web.env.SESSION_SECRET).toBeUndefined();
  expect(stack.fromTemplate).toBe("widget");
  expect(stack.fromTemplateVersion).toBe("1");

  // audit rows for BOTH the publish and the instantiate
  expect((await audit.list({ action: "template.publish" })).entries.map((e: any) => e.target)).toContain("widget");
  expect((await audit.list({ action: "stack.instantiate" })).entries.map((e: any) => e.target)).toContain("shop");
  // secret VALUE never lands in the audit trail
  expect(JSON.stringify(await audit.list({ action: "stack.instantiate" }))).not.toContain("top-secret-value");
  await db.destroy();
});

test("template instantiate dry-run returns the plan and creates nothing", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/templates", "alice", { slug: "widget", spec: widgetTpl, variables: sessionVar });
  const dry = await call(app, "POST", "/v1/templates/widget/instantiate?dry_run=1", "alice", { name: "shop2", vars: { session: "x" } });
  expect(dry.status).toBe(200);
  const b = await dry.json();
  expect(b.dryRun).toBe(true);
  expect(b.plan.map((s: any) => [s.action, s.key])).toEqual([["create", "db"], ["create", "web"]]);
  expect(kube.applies.length).toBe(0); // nothing hit the cluster
  expect((await call(app, "GET", "/v1/stacks/shop2", "alice")).status).toBe(404); // no stack created
  await db.destroy();
});

test("template instantiate: a missing required variable is a 400 (no stack created)", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/templates", "alice", { slug: "widget", spec: widgetTpl, variables: sessionVar });
  const miss = await call(app, "POST", "/v1/templates/widget/instantiate", "alice", { name: "shop3", vars: {} });
  expect(miss.status).toBe(400);
  expect((await miss.json()).missing).toContain("session");
  expect((await call(app, "GET", "/v1/stacks/shop3", "alice")).status).toBe(404);
  await db.destroy();
});

test("template visibility: an org template is 404 for a non-member (list + get + instantiate)", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  const spec = { name: "internaltpl", resources: { db: { type: "database" } } };
  expect((await call(app, "POST", "/v1/templates?org=acme", "alice", { slug: "internal", visibility: "org", spec, variables: [] })).status).toBe(200);

  // alice (member) sees it; bob (outsider) does not
  expect((await (await call(app, "GET", "/v1/templates/internal", "alice")).json()).slug).toBe("internal");
  expect((await call(app, "GET", "/v1/templates/internal", "bob")).status).toBe(404);
  expect((await (await call(app, "GET", "/v1/templates", "bob")).json()).templates.map((t: any) => t.slug)).not.toContain("internal");
  expect((await call(app, "POST", "/v1/templates/internal/instantiate", "bob", { name: "x" })).status).toBe(404);
  await db.destroy();
});

test("template publish FAILS CLOSED on a credential-looking value; --allow lets it through (audited)", async () => {
  const { app, audit, db } = await mk();
  const leaky = { name: "leaky", resources: { web: { type: "app", image: "w:1", env: { API_TOKEN: "aB3xK9pQ2mZ7wL4vR8nT" } } } };
  const bad = await call(app, "POST", "/v1/templates", "alice", { slug: "leaky", spec: leaky, variables: [] });
  expect(bad.status).toBe(400);
  expect((await bad.json()).flags.length).toBe(1);

  const ok = await call(app, "POST", "/v1/templates", "alice", { slug: "leaky", spec: leaky, variables: [], allow: ["API_TOKEN"] });
  expect(ok.status).toBe(200);
  const trail = await audit.list({ action: "template.publish" });
  expect((trail.entries.find((e: any) => e.target === "leaky")!.detail as any).allow).toEqual(["API_TOKEN"]);
  await db.destroy();
});

test("template publish preserves ${var} placeholders in TYPED fields; instantiate substitutes them", async () => {
  const { app, db } = await mk();
  const spec = { name: "sized", resources: { db: { type: "database", storage: "${var.db_storage}" } } };
  await call(app, "POST", "/v1/templates", "alice", { slug: "sized", spec, variables: [{ key: "db_storage", default: "1Gi", required: false }] });
  // the stored template spec keeps the placeholder (the full sanitizer would have reset it to the default)
  const get = await (await call(app, "GET", "/v1/templates/sized", "alice")).json();
  expect(get.spec.resources.db.storage).toBe("${var.db_storage}");
  // instantiate with an override (within the 1Gi per-database cap) → substituted into the concrete spec
  const inst = await call(app, "POST", "/v1/templates/sized/instantiate", "alice", { name: "sizedstack", vars: { db_storage: "512Mi" } });
  expect(inst.status).toBe(200);
  const stack = await (await call(app, "GET", "/v1/stacks/sizedstack", "alice")).json();
  expect(stack.spec.resources.db.storage).toBe("512Mi");
  await db.destroy();
});

// ============================ D2: template upstream diff (outdated / upgrade) ============================
// A simple, placeholder-free template so the route's default-substitution produces a concrete spec that
// matches the instantiated stack exactly (no phantom drift): a db + an app that uses it.
// Storage values stay within the test config's 1Gi per-database cap so sanitize doesn't clamp them equal.
const kitV1 = { name: "kit", resources: { db: { type: "database", storage: "1Gi" }, web: { type: "app", image: "web:1", uses: [{ database: "db" }] } } };
const kitV2 = { name: "kit", resources: { db: { type: "database", storage: "512Mi" }, web: { type: "app", image: "web:2", uses: [{ database: "db" }] } } };

// Publish kit v1, instantiate it into `stackName`. Returns the harness for further calls.
async function seedKit(app: any, stackName: string) {
  await call(app, "POST", "/v1/templates", "alice", { slug: "kit", spec: kitV1, variables: [] });
  const inst = await call(app, "POST", "/v1/templates/kit/instantiate", "alice", { name: stackName });
  expect(inst.status).toBe(200);
}

test("outdated: a template-derived stack on the latest version is upToDate; a non-derived stack 404s", async () => {
  const { app, db } = await mk();
  await seedKit(app, "myapp");
  const up = await call(app, "GET", "/v1/stacks/myapp/outdated", "alice");
  expect(up.status).toBe(200);
  const body = await up.json();
  expect(body.upToDate).toBe(true);
  expect(body.templateDerived).toBe(true);
  expect(body.latestVersion).toBe("1");

  // a hand-written (non-template) stack → 404 templateDerived:false
  await call(app, "POST", "/v1/stacks/plain/up", "alice", { spec: { name: "plain", resources: { db: { type: "database" } } } });
  const nd = await call(app, "GET", "/v1/stacks/plain/outdated", "alice");
  expect(nd.status).toBe(404);
  expect((await nd.json()).templateDerived).toBe(false);
  await db.destroy();
});

test("outdated: a new template version surfaces upstream-only field changes (no local drift → no conflict)", async () => {
  const { app, db } = await mk();
  await seedKit(app, "myapp");
  // publish kit v2 (db 1Gi→2Gi, web web:1→web:2)
  await call(app, "POST", "/v1/templates", "alice", { slug: "kit", spec: kitV2, variables: [] });

  const res = await call(app, "GET", "/v1/stacks/myapp/outdated", "alice");
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b.upToDate).toBe(false);
  expect(b.fromVersion).toBe("1");
  expect(b.latestVersion).toBe("2");
  expect(b.diff.upstreamChanged).toBe(true);
  expect(b.diff.hasLocalDrift).toBe(false);
  expect(b.diff.conflicts).toEqual([]);
  const byKey = Object.fromEntries(b.diff.resources.map((r: any) => [r.key, r]));
  expect(byKey.db.class).toBe("upstream-only");
  expect(byKey.db.fields.find((f: any) => f.field === "storage")).toMatchObject({ class: "upstream-only", pinned: "1Gi", latest: "512Mi" });
  expect(byKey.web.class).toBe("upstream-only");
  await db.destroy();
});

test("upgrade dry-run returns the reconcile plan (update steps) and applies nothing", async () => {
  const { app, kube, db } = await mk();
  await seedKit(app, "myapp");
  await call(app, "POST", "/v1/templates", "alice", { slug: "kit", spec: kitV2, variables: [] });
  const kubeBefore = kube.dbApplies.length + kube.applies.length;

  const dry = await call(app, "POST", "/v1/stacks/myapp/upgrade?dry_run=1", "alice", {});
  expect(dry.status).toBe(200);
  const b = await dry.json();
  expect(b.dryRun).toBe(true);
  expect(b.toVersion).toBe("2");
  expect(b.autoApplied.sort()).toEqual(["db", "web"]);
  expect(b.plan.filter((s: any) => s.action === "update").map((s: any) => s.key).sort()).toEqual(["db", "web"]);
  // nothing hit the cluster and provenance is unchanged
  expect(kube.dbApplies.length + kube.applies.length).toBe(kubeBefore);
  expect((await (await call(app, "GET", "/v1/stacks/myapp", "alice")).json()).fromTemplateVersion).toBe("1");
  await db.destroy();
});

test("upgrade: a local-drift + upstream change on the SAME key is a conflict → 409 until resolved", async () => {
  const { app, db } = await mk();
  await seedKit(app, "myapp");
  // local drift: change db storage to 256Mi via a plain up (web unchanged, still web:1)
  const drift = await call(app, "POST", "/v1/stacks/myapp/up", "alice", {
    spec: { name: "myapp", resources: { db: { type: "database", storage: "256Mi" }, web: { type: "app", image: "web:1", uses: [{ database: "db" }] } } },
    resolved: { web: { image: "web:1" } },
    spec_version: 1,
  });
  expect(drift.status).toBe(200);
  // upstream v2 changes db (→512Mi) AND web (→web:2)
  await call(app, "POST", "/v1/templates", "alice", { slug: "kit", spec: kitV2, variables: [] });

  // db is a conflict (pinned 1Gi / latest 512Mi / local 256Mi); web is a clean upstream-only change
  const outdated = await (await call(app, "GET", "/v1/stacks/myapp/outdated", "alice")).json();
  expect(outdated.diff.conflicts).toEqual(["db"]);

  // upgrade with no resolution → 409 listing the unresolved conflict
  const blocked = await call(app, "POST", "/v1/stacks/myapp/upgrade", "alice", {});
  expect(blocked.status).toBe(409);
  expect((await blocked.json()).conflicts).toEqual(["db"]);

  // resolve db=keep-local → 200; db stays 256Mi, web still auto-upgrades to web:2
  const resolved = await call(app, "POST", "/v1/stacks/myapp/upgrade", "alice", { resolutions: { db: "keep-local" } });
  expect(resolved.status).toBe(200);
  const stack = await (await call(app, "GET", "/v1/stacks/myapp", "alice")).json();
  expect(stack.spec.resources.db.storage).toBe("256Mi"); // kept local
  expect(stack.spec.resources.web.image).toBe("web:2"); // auto-applied upstream
  await db.destroy();
});

test("upgrade execute bumps from_template_version to the target and audits stack.upgrade", async () => {
  const { app, audit, db } = await mk();
  await seedKit(app, "myapp");
  await call(app, "POST", "/v1/templates", "alice", { slug: "kit", spec: kitV2, variables: [] });

  const res = await call(app, "POST", "/v1/stacks/myapp/upgrade", "alice", { resolved: { web: { image: "web:2" } } });
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b.toVersion).toBe("2");

  // provenance re-pinned to the target
  const stack = await (await call(app, "GET", "/v1/stacks/myapp", "alice")).json();
  expect(stack.fromTemplateVersion).toBe("2");
  expect(stack.spec.resources.db.storage).toBe("512Mi");

  // a follow-up outdated is now upToDate
  expect((await (await call(app, "GET", "/v1/stacks/myapp/outdated", "alice")).json()).upToDate).toBe(true);

  // audited as stack.upgrade with the version transition
  const trail = await audit.list({ action: "stack.upgrade" });
  const row = trail.entries.find((e: any) => e.target === "myapp")!;
  expect(row).toBeTruthy();
  expect(row.detail).toMatchObject({ template: "kit", from: "1", to: "2" });
  await db.destroy();
});

test("upgrade: a non-template-derived stack cannot be upgraded → 404", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/stacks/plain/up", "alice", { spec: { name: "plain", resources: { db: { type: "database" } } } });
  const res = await call(app, "POST", "/v1/stacks/plain/upgrade", "alice", {});
  expect(res.status).toBe(404);
  await db.destroy();
});

// ============================ I1: buckets + item 10 quotas ============================

test("bucket create returns creds ONCE; detail exposes usage but NEVER creds; audited", async () => {
  const { app, audit, db } = await mk();
  const res = await call(app, "POST", "/v1/buckets/avatars", "alice");
  expect(res.status).toBe(200);
  const created = await res.json();
  expect(created.name).toBe("avatars");
  expect(created.prefix).toMatch(/^buckets\/.+\/avatars\/$/);
  expect(created.accessKeyId).toBeTruthy();
  expect(created.secretAccessKey).toBe("secret-avatars-0"); // FakeBucketStore's creds — revealed once

  // detail folds bucket usage in, but carries NO credentials
  const detail = await (await call(app, "GET", "/v1/sites/avatars", "alice")).json();
  expect(detail.type).toBe("bucket");
  expect(detail.bucket).toEqual({ endpoint: "http://fake-s3.local", bucket: "platform-bucket", prefix: created.prefix, bytes: 0, objects: 0 });
  expect(detail.status).toEqual({ status: "running", reason: "ready" });
  expect(JSON.stringify(detail)).not.toContain("secret-avatars"); // the secret never appears in detail
  expect(JSON.stringify(detail)).not.toContain("accessKeyId");

  const trail = await audit.list({ action: "bucket.create" });
  expect(trail.entries.map((e: any) => e.target)).toContain("avatars");
  await db.destroy();
});

test("bucket rotate re-mints creds (once) and is audited", async () => {
  const { app, audit, bucket, db } = await mk();
  await call(app, "POST", "/v1/buckets/uploads", "alice");
  const r = await call(app, "POST", "/v1/buckets/uploads/rotate", "alice");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.secretAccessKey).toBe("secret-uploads-1"); // bumped by rotate
  expect(bucket.rotations.length).toBe(1);
  const trail = await audit.list({ action: "bucket.rotate" });
  expect(trail.entries.map((e: any) => e.target)).toContain("uploads");
  await db.destroy();
});

test("bucket delete requires ?force=1 when non-empty (409), else tears down", async () => {
  const { app, meta, bucket, audit, db } = await mk();
  await call(app, "POST", "/v1/buckets/data", "alice");
  const site = (await meta.getSitePlain("data"))!;
  bucket.usageByKey.set(`${site.namespace}/data`, { bytes: 1024, objects: 2 }); // simulate a non-empty bucket

  const refused = await call(app, "DELETE", "/v1/sites/data", "alice");
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toMatch(/object\(s\)/);

  const forced = await call(app, "DELETE", "/v1/sites/data?force=1", "alice");
  expect(forced.status).toBe(200);
  expect(bucket.destroyed).toContain(`${site.namespace}/data`);
  expect(await meta.getSitePlain("data")).toBeNull();
  const trail = await audit.list({ action: "bucket.delete" });
  expect(trail.entries.map((e: any) => e.target)).toContain("data");
  await db.destroy();
});

test("bucket binding writes S3_* creds into the app's write-only secret (unprefixed for a single bind)", async () => {
  const { app, secrets, db } = await mk();
  await call(app, "POST", "/v1/buckets/media", "alice");
  const deploy = await call(app, "POST", "/v1/apps/gallery", "alice", { image: "x:1", uses: [{ bucket: "media" }] });
  expect(deploy.status).toBe(200);
  // The five S3_* keys landed in SOME app secret bag, with the derived values (never in the manifest).
  const bags = [...secrets.values.values()];
  const bag = bags.find((m) => m.get("S3_BUCKET") === "platform-bucket")!;
  expect(bag).toBeTruthy();
  expect(bag.get("S3_ENDPOINT")).toBe("http://fake-s3.local");
  expect(bag.get("S3_PREFIX")).toMatch(/^buckets\/.+\/media\/$/);
  expect(bag.get("S3_ACCESS_KEY_ID")).toBe("AKIA-media");
  expect(bag.get("S3_SECRET_ACCESS_KEY")).toBe("secret-media-0");
  await db.destroy();
});

test("cross-org bucket binding is refused (400)", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/buckets/alicebucket", "alice"); // alice's personal org
  const res = await call(app, "POST", "/v1/apps/bobapp", "bob", { image: "x:1", uses: [{ bucket: "alicebucket" }] });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/different organisation/);
  await db.destroy();
});

test("quota override: per-org max_db_storage raises the db-create cap", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await call(app, "POST", "/v1/orgs", "alice", { slug: "team", name: "Team" });

  // default cap (1Gi) rejects a 2Gi request
  expect((await call(app, "POST", "/v1/databases/big?org=team", "alice", { storage: "2Gi" })).status).toBe(400);

  // raise the cap for the org, then the same request succeeds
  const put = await call(app, "PUT", "/v1/admin/orgs/team/quotas", "alice", { quotas: { max_db_storage: "5Gi" } });
  expect(put.status).toBe(200);
  const ok = await call(app, "POST", "/v1/databases/big?org=team", "alice", { storage: "2Gi" });
  expect(ok.status).toBe(200);

  // and the override is audited
  const trail = await (await call(app, "GET", "/v1/admin/audit?action=quota.set", "alice")).json();
  expect(trail.entries.map((e: any) => e.detail?.key)).toContain("max_db_storage");
  await db.destroy();
});

test("storage budget: a new database request that exceeds the org budget is rejected (429)", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await call(app, "POST", "/v1/orgs", "alice", { slug: "team", name: "Team" });
  await call(app, "PUT", "/v1/admin/orgs/team/quotas", "alice", { quotas: { storage_budget_bytes: "512Mi" } });
  const res = await call(app, "POST", "/v1/databases/db1?org=team", "alice", { storage: "1Gi" });
  expect(res.status).toBe(429);
  expect((await res.json()).error).toMatch(/storage budget exceeded/);
  await db.destroy();
});

test("org usage gains a storage section (databases + buckets + budget)", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await call(app, "POST", "/v1/orgs", "alice", { slug: "team", name: "Team" });
  await call(app, "POST", "/v1/databases/d1?org=team", "alice", { storage: "1Gi" });
  await call(app, "POST", "/v1/buckets/b1?org=team", "alice");

  const usage = await (await call(app, "GET", "/v1/orgs/team/usage", "alice")).json();
  expect(usage.workloads.database).toBe(1);
  expect(usage.workloads.bucket).toBe(1);
  expect(usage.storage.databases).toEqual({ count: 1, requestedBytes: 2 ** 30 });
  expect(usage.storage.buckets.count).toBe(1);
  expect(usage.storage.budget).toBeNull(); // no budget set

  // once a budget is set it surfaces in usage
  await call(app, "PUT", "/v1/admin/orgs/team/quotas", "alice", { quotas: { storage_budget_bytes: "10Gi" } });
  const usage2 = await (await call(app, "GET", "/v1/orgs/team/usage", "alice")).json();
  expect(usage2.storage.budget).toBe(10 * 2 ** 30);
  await db.destroy();
});

// ---- (I2) managed cache (Valkey) --------------------------------------------------------------
test("cache create returns REDIS_URL (password embedded) ONCE; detail exposes host/memory but NEVER the password; audited", async () => {
  const { app, kube, meta, audit, db } = await mk();
  const res = await call(app, "POST", "/v1/caches/sessions", "alice", { memory: "128Mi" });
  expect(res.status).toBe(200);
  const created = await res.json();
  expect(created.name).toBe("sessions");
  expect(created.memory).toBe("128Mi");
  expect(created.persistent).toBe(false);
  expect(created.host).toMatch(/^sessions\..+\.svc\.cluster\.local$/);
  expect(created.url).toMatch(/^redis:\/\/:.+@sessions\..+\.svc\.cluster\.local:6379$/);
  // the password embedded in the URL is what FakeKube stored for the applied cache
  const ns = (await meta.getSitePlain("sessions"))!.namespace;
  const password = decodeURIComponent(created.url.slice("redis://:".length, created.url.indexOf("@")));
  expect(await kube.readCachePassword(ns, "sessions")).toBe(password);

  // the applied manifest set: Deployment + Service + Secret (create) — no PVC (ephemeral)
  const applied = kube.cacheApplies.find((a) => a.name === "sessions")!.manifests;
  expect(applied.deployment).toBeDefined();
  expect(applied.service).toBeDefined();
  expect((applied.secret as any).stringData.password).toBe(password);
  expect(applied.pvc).toBeUndefined();

  // detail: host/port/memory/persistent + running status; the password NEVER appears
  const detail = await (await call(app, "GET", "/v1/sites/sessions", "alice")).json();
  expect(detail.type).toBe("cache");
  expect(detail.cache.port).toBe(6379);
  expect(detail.cache.memory).toBe("128Mi");
  expect(detail.cache.persistent).toBe(false);
  expect(detail.status.status).toBe("running"); // FakeKube healthy Deployment default
  expect(JSON.stringify(detail)).not.toContain(password);

  const trail = await audit.list({ action: "cache.create" });
  expect(trail.entries.map((e: any) => e.target)).toContain("sessions");
  await db.destroy();
});

test("cache delete tears down the Valkey (Deployment/Service/Secret + PVC); audited", async () => {
  const { app, kube, meta, audit, db } = await mk();
  await call(app, "POST", "/v1/caches/cache1", "alice", { persistent: true });
  const res = await call(app, "DELETE", "/v1/sites/cache1", "alice");
  expect(res.status).toBe(200);
  expect(kube.cacheDeletes.map((d) => d.name)).toContain("cache1");
  expect(await meta.getSitePlain("cache1")).toBeNull();
  const trail = await audit.list({ action: "cache.delete" });
  expect(trail.entries.map((e: any) => e.target)).toContain("cache1");
  await db.destroy();
});

test("cache binding: deploy uses:[{cache}] writes REDIS_URL into the app's write-only secret (never a manifest)", async () => {
  const { app, kube, meta, secrets, db } = await mk();
  await call(app, "POST", "/v1/caches/kv", "alice", {});
  const deploy = await call(app, "POST", "/v1/apps/worker", "alice", { image: "x:1", uses: [{ cache: "kv" }] });
  expect(deploy.status).toBe(200);
  // REDIS_URL landed in an app secret bag with the cache's password + in-namespace host
  const bags = [...secrets.values.values()];
  const bag = bags.find((m) => m.has("REDIS_URL"))!;
  expect(bag).toBeTruthy();
  const url = bag.get("REDIS_URL")!;
  expect(url).toMatch(/^redis:\/\/:.+@kv\..+\.svc\.cluster\.local:6379$/);
  // the password in REDIS_URL matches what the container reads (single source of truth: the Secret)
  const ns = (await meta.getSitePlain("kv"))!.namespace;
  const password = decodeURIComponent(url.slice("redis://:".length, url.indexOf("@")));
  expect(await kube.readCachePassword(ns, "kv")).toBe(password);
  // it never leaked into the app Deployment's manifest
  const applied = kube.applies.find((a) => a.name === "worker")!.manifests;
  expect(JSON.stringify(applied)).not.toContain(password);
  await db.destroy();
});

test("cache binding referencing a missing cache → 400; a cache in a DIFFERENT org → 400", async () => {
  const { app, db } = await mk();
  const missing = await call(app, "POST", "/v1/apps/a1", "alice", { image: "x:1", uses: [{ cache: "ghostcache" }] });
  expect(missing.status).toBe(400);
  expect((await missing.json()).error).toContain("ghostcache");

  await call(app, "POST", "/v1/caches/alicecache", "alice", {}); // alice's personal org
  const crossOrg = await call(app, "POST", "/v1/apps/bobapp", "bob", { image: "x:1", uses: [{ cache: "alicecache" }] });
  expect(crossOrg.status).toBe(400);
  expect((await crossOrg.json()).error).toContain("different organisation");
  await db.destroy();
});

test("storage budget: a PERSISTENT cache counts toward the budget (ephemeral does not)", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await call(app, "POST", "/v1/orgs", "alice", { slug: "team", name: "Team" });
  await call(app, "PUT", "/v1/admin/orgs/team/quotas", "alice", { quotas: { storage_budget_bytes: "256Mi" } });
  // an ephemeral cache costs no storage → allowed even at a tiny budget
  expect((await call(app, "POST", "/v1/caches/eph?org=team", "alice", { memory: "256Mi" })).status).toBe(200);
  // a persistent cache whose PVC (512Mi) exceeds the remaining budget → 429
  const over = await call(app, "POST", "/v1/caches/big?org=team", "alice", { memory: "512Mi", persistent: true });
  expect(over.status).toBe(429);
  expect((await over.json()).error).toMatch(/storage budget exceeded/);
  // org usage surfaces the caches storage section
  const usage = await (await call(app, "GET", "/v1/orgs/team/usage", "alice")).json();
  expect(usage.workloads.cache).toBe(1); // only the ephemeral one claimed
  expect(usage.storage.caches).toEqual({ count: 0, bytes: 0 }); // ephemeral → 0 persistent PVCs
  await db.destroy();
});

// ---- (K1) managed auth resource (GoTrue) ------------------------------------------------------
test("auth create REQUIRES a same-org database: 400 without db, 400 cross-org, 200 with a same-org db", async () => {
  const { app, kube, meta, audit, db } = await mk();
  // no db → 400
  const noDb = await call(app, "POST", "/v1/auths/shop", "alice", {});
  expect(noDb.status).toBe(400);
  expect((await noDb.json()).error).toMatch(/requires a database/);
  // a db owned by BOB (a different org) → cross-org 400 (name is never claimed on this failure)
  await call(app, "POST", "/v1/databases/bobdb", "bob", {});
  const crossOrg = await call(app, "POST", "/v1/auths/shop", "alice", { db: "bobdb" });
  expect(crossOrg.status).toBe(400);
  expect((await crossOrg.json()).error).toMatch(/different organisation/);
  expect(await meta.getSitePlain("shop")).toBeNull(); // not claimed on the rejected create

  // a same-org db → 200, engine applied, keys Secret minted, audited
  await call(app, "POST", "/v1/databases/appdb", "alice", {});
  const ok = await call(app, "POST", "/v1/auths/shop", "alice", { db: "appdb", signup: "closed" });
  expect(ok.status).toBe(200);
  const created = await ok.json();
  expect(created.db).toBe("appdb");
  expect(created.jwtAlg).toBe("HS256");
  expect(created.url).toBe("https://auth--shop.drop.example.com");
  const applied = kube.authApplies.find((a) => a.name === "shop")!.manifests;
  expect((applied.httpScaledObject as any).spec.replicas).toEqual({ min: 1, max: 1 }); // 1/1
  expect((applied.keysSecret as any).stringData["jwt-secret"]).toBeTruthy();
  const trail = await audit.list({ action: "auth.create" });
  expect(trail.entries.map((e: any) => e.target)).toContain("shop");
  await db.destroy();
});

test("auth detail carries the config surface + key age but NEVER key material", async () => {
  const { app, kube, meta, db } = await mk();
  await call(app, "POST", "/v1/databases/appdb", "alice", {});
  await call(app, "POST", "/v1/auths/shop", "alice", { db: "appdb", providers: { google: { client_id: "g-1" } } });
  const ns = (await meta.getSitePlain("shop"))!.namespace;
  const secret = await kube.readAuthJwtSecret(ns, "shop");
  expect(secret).toBeTruthy();

  const detail = await (await call(app, "GET", "/v1/sites/shop", "alice")).json();
  expect(detail.type).toBe("auth");
  expect(detail.auth.db).toBe("appdb");
  expect(detail.auth.providers).toEqual(["google"]);
  expect(detail.auth.signup).toBe("open");
  expect(detail.auth.jwtAlg).toBe("HS256");
  expect(detail.auth.keyMintedAt).toBeTruthy(); // key AGE is surfaced…
  expect(detail.status.status).toBe("running");
  expect(JSON.stringify(detail)).not.toContain(secret); // …but the key MATERIAL never is
  await db.destroy();
});

test("rotate-keys re-mints the JWT secret and is audited", async () => {
  const { app, kube, meta, audit, db } = await mk();
  await call(app, "POST", "/v1/databases/appdb", "alice", {});
  await call(app, "POST", "/v1/auths/shop", "alice", { db: "appdb" });
  const ns = (await meta.getSitePlain("shop"))!.namespace;
  const before = await kube.readAuthJwtSecret(ns, "shop");
  const res = await call(app, "POST", "/v1/auths/shop/rotate-keys", "alice");
  expect(res.status).toBe(200);
  const after = await kube.readAuthJwtSecret(ns, "shop");
  expect(after).toBeTruthy();
  expect(after).not.toBe(before); // re-minted
  const trail = await audit.list({ action: "auth.rotate-keys" });
  expect(trail.entries.map((e: any) => e.target)).toContain("shop");
  await db.destroy();
});

test("uses:[{auth}] binding injects AUTH_URL + AUTH_JWT_SECRET into the app's write-only secret (never a manifest)", async () => {
  const { app, kube, meta, secrets, db } = await mk();
  await call(app, "POST", "/v1/databases/appdb", "alice", {});
  await call(app, "POST", "/v1/auths/shop", "alice", { db: "appdb" });
  const ns = (await meta.getSitePlain("shop"))!.namespace;
  const secret = (await kube.readAuthJwtSecret(ns, "shop"))!;

  const deploy = await call(app, "POST", "/v1/apps/web", "alice", { image: "x:1", uses: [{ auth: "shop" }] });
  expect(deploy.status).toBe(200);
  const bag = [...secrets.values.values()].find((m) => m.has("AUTH_JWT_SECRET"))!;
  expect(bag).toBeTruthy();
  expect(bag.get("AUTH_URL")).toBe("https://auth--shop.drop.example.com");
  expect(bag.get("AUTH_JWT_SECRET")).toBe(secret); // the shared HS256 secret (write-only path)
  // the secret never leaked into the app Deployment's manifest
  const applied = kube.applies.find((a) => a.name === "web")!.manifests;
  expect(JSON.stringify(applied)).not.toContain(secret);
  await db.destroy();
});

test("uses:[{auth}] referencing a missing auth → 400; a cross-org auth → 400", async () => {
  const { app, db } = await mk();
  const missing = await call(app, "POST", "/v1/apps/a1", "alice", { image: "x:1", uses: [{ auth: "ghostauth" }] });
  expect(missing.status).toBe(400);
  expect((await missing.json()).error).toContain("ghostauth");

  await call(app, "POST", "/v1/databases/adb", "alice", {});
  await call(app, "POST", "/v1/auths/aliceauth", "alice", { db: "adb" });
  const crossOrg = await call(app, "POST", "/v1/apps/bobapp", "bob", { image: "x:1", uses: [{ auth: "aliceauth" }] });
  expect(crossOrg.status).toBe(400);
  expect((await crossOrg.json()).error).toContain("different organisation");
  await db.destroy();
});

test("user-admin proxy is configure-gated + audited (via a FakeEngine transport); MCP has no user CRUD", async () => {
  const { FakeEngine } = await import("../auth-resource/engine.ts");
  const calls: any[] = [];
  const authAdmin = async (r: any) => {
    calls.push(r);
    if (r.method === "GET") return { status: 200, json: { users: [{ id: "u1", email: "u1@x.com" }] } };
    if (r.method === "POST") return { status: 200, json: { id: "u2", email: r.body.email } };
    if (r.method === "DELETE") return { status: 200, json: { deleted: true } };
    return { status: 200, json: {} };
  };
  const { app, db } = await mk({ authEngine: new FakeEngine(), authAdmin });
  await call(app, "POST", "/v1/databases/appdb", "alice", {});
  await call(app, "POST", "/v1/auths/shop", "alice", { db: "appdb" });

  // list — proxied, owner-gated
  const list = await call(app, "GET", "/v1/auths/shop/users", "alice");
  expect(list.status).toBe(200);
  expect((await list.json()).users[0].id).toBe("u1");
  expect(calls.some((c) => c.method === "GET" && c.token && c.path === "/admin/users")).toBe(true);
  // the admin token was minted server-side + sent as a Bearer (never leaves the server otherwise)
  expect(calls.find((c) => c.method === "GET").token).toBeTruthy();

  // create-with-temp-password — RevealOnce temp password echoed once + audited
  const create = await call(app, "POST", "/v1/auths/shop/users", "alice", { email: "new@x.com" });
  expect(create.status).toBe(200);
  const cj = await create.json();
  expect(cj.tempPassword).toBeTruthy(); // generated + returned once
  expect(calls.find((c) => c.method === "POST").body.email_confirm).toBe(true); // pre-confirmed (no SMTP)

  // a NON-owner (bob) is forbidden — configure-gated
  expect((await call(app, "GET", "/v1/auths/shop/users", "bob")).status).toBe(403);
  expect((await call(app, "POST", "/v1/auths/shop/users", "bob", { email: "x@x.com" })).status).toBe(403);

  await db.destroy();
});

// ---- (I3) extensions + pooler -----------------------------------------------------------------
test("db create --ext renders postInitApplicationSQL; unknown extension → 400; ext ls reads the stored config; ext add → 409", async () => {
  const { app, kube, db } = await mk();
  // unknown extension rejected up front
  const bad = await call(app, "POST", "/v1/databases/vecdb", "alice", { extensions: ["mystery"] });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toMatch(/not allowed/);

  // create with allowlisted extensions → CREATE EXTENSION in the CNPG bootstrap
  const ok = await call(app, "POST", "/v1/databases/vecdb", "alice", { extensions: ["pgvector", "pg_trgm"] });
  expect(ok.status).toBe(200);
  const cluster = kube.dbApplies.find((a) => a.name === "vecdb")!.manifests.cluster as any;
  expect(cluster.spec.bootstrap.initdb.postInitApplicationSQL).toEqual([
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
  ]);
  // ext ls (via detail) reflects the stored list
  const detail = await (await call(app, "GET", "/v1/sites/vecdb", "alice")).json();
  expect(detail.database.extensions).toEqual(["pgvector", "pg_trgm"]);
  // ext add on an existing db is an honest 409 (v1 limitation)
  const add = await call(app, "POST", "/v1/databases/vecdb/extensions", "alice", { add: ["citext"] });
  expect(add.status).toBe(409);
  expect((await add.json()).error).toMatch(/v1 limitation/);
  await db.destroy();
});

test("pooler enable emits a CNPG Pooler; detail surfaces it; disable deletes it; both audited", async () => {
  const { app, kube, audit, db } = await mk();
  await call(app, "POST", "/v1/databases/pgdb", "alice", {});
  // enable (transaction mode)
  const en = await call(app, "POST", "/v1/databases/pgdb/pooler", "alice", { enable: true, mode: "transaction" });
  expect(en.status).toBe(200);
  expect((await en.json()).pooler).toEqual({ enabled: true, mode: "transaction", host: expect.stringContaining("pgdb-pooler-rw.") });
  const pooler = kube.poolerApplies.at(-1)!.manifest as any;
  expect(pooler.kind).toBe("Pooler");
  expect(pooler.metadata.name).toBe("pgdb-pooler-rw");
  expect(pooler.spec.pgbouncer.poolMode).toBe("transaction");
  // detail surfaces pooler state
  const detail = await (await call(app, "GET", "/v1/sites/pgdb", "alice")).json();
  expect(detail.database.pooler).toEqual({ enabled: true, mode: "transaction", host: expect.stringContaining("pgdb-pooler-rw.") });
  // disable
  const dis = await call(app, "POST", "/v1/databases/pgdb/pooler", "alice", { enable: false });
  expect(dis.status).toBe(200);
  expect(kube.poolerDeletes.map((d) => d.dbName)).toContain("pgdb");
  const detail2 = await (await call(app, "GET", "/v1/sites/pgdb", "alice")).json();
  expect(detail2.database.pooler).toEqual({ enabled: false });
  // both actions audited
  expect((await audit.list({ action: "db.pooler.enable" })).entries.map((e: any) => e.target)).toContain("pgdb");
  expect((await audit.list({ action: "db.pooler.disable" })).entries.map((e: any) => e.target)).toContain("pgdb");
  await db.destroy();
});

test("deploy uses:[{database, via: pooler}] wires PGHOST at the pooler Service", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/databases/maindb", "alice", {});
  const res = await call(app, "POST", "/v1/apps/webapi", "alice", { image: "x:1", uses: [{ database: "maindb", via: "pooler" }] });
  expect(res.status).toBe(200);
  const ctr = (kube.applies.find((a) => a.name === "webapi")!.manifests.deployment as any).spec.template.spec.containers[0];
  expect(ctr.env).toContainEqual({ name: "PGHOST", value: "maindb-pooler-rw" });
  await db.destroy();
});

test("admin quota routes are admin-only; PUT validates keys", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await call(app, "POST", "/v1/orgs", "alice", { slug: "team", name: "Team" });
  // bob is not an admin
  expect((await call(app, "GET", "/v1/admin/orgs/team/quotas", "bob")).status).toBe(403);
  // unknown key rejected
  expect((await call(app, "PUT", "/v1/admin/orgs/team/quotas", "alice", { quotas: { bogus: "1" } })).status).toBe(400);
  // GET returns effective values folded over defaults
  const q = await (await call(app, "GET", "/v1/admin/orgs/team/quotas", "alice")).json();
  expect(q.effective.max_db_storage).toBe("1Gi");
  expect(q.effective.storage_budget_bytes).toBeNull();
  await db.destroy();
});

// ============================ TCP (L4) exposure (A2b) ======================================

test("expose sni on a database: 200 + connect string + audit + detail surface", async () => {
  const { app, kube, audit, db } = await mk();
  await call(app, "POST", "/v1/databases/pg", "alice", {}); // claim + apply the DB
  const res = await call(app, "POST", "/v1/sites/pg/expose", "alice", { mode: "sni" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tcp).toMatchObject({ mode: "sni", protocol: "postgres", port: null, connect: "pg.drop.example.com:5432" });
  expect(body.tcp.sslmode).toMatch(/sslmode=require/);
  // tenant re-applied WITH the edge-tcp allow policy for this DB (cnpg selector)
  const lastTenant = kube.tenantApplies[kube.tenantApplies.length - 1]!.manifests as any;
  expect(lastTenant.edgeTcpPolicies).toHaveLength(1);
  expect(lastTenant.edgeTcpPolicies[0].spec.podSelector.matchLabels["cnpg.io/cluster"]).toBe("pg");
  // audit
  const trail = await audit.list({ action: "tcp.expose" });
  expect(trail.entries[0]).toMatchObject({ target: "pg", targetType: "database" });
  // detail surface
  const detail = await (await call(app, "GET", "/v1/sites/pg", "alice")).json();
  expect(detail.tcp).toMatchObject({ mode: "sni", protocol: "postgres", connect: "pg.drop.example.com:5432" });
  await db.destroy();
});

test("expose port on an app (scale.min>=1): allocates a port, patches the edge-tcp Service, lb-host connect", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/cache", "alice", { image: "redis:1", scale: { min: 1, max: 1 } });
  const res = await call(app, "POST", "/v1/sites/cache/expose", "alice", { mode: "port", protocol: "redis" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tcp).toMatchObject({ mode: "port", protocol: "redis", port: 7000, connect: "drop.example.com:7000" }); // port mode = raw LB host (no SNI prefix)
  // the edge-tcp Service was patched to include the shared port + the newly-allocated dynamic port
  const patch = kube.edgeTcpPortPatches[kube.edgeTcpPortPatches.length - 1]!;
  expect(patch.ports.map((p) => p.port).sort((a, b) => a - b)).toEqual([5432, 7000]);
  await db.destroy();
});

test("expose: a scale.min=0 app is refused (no scale-to-zero for TCP) → 400", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/web", "alice", { image: "x:1", scale: { min: 0, max: 3 } });
  const res = await call(app, "POST", "/v1/sites/web/expose", "alice", { mode: "sni" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/scale\.min >= 1/);
  await db.destroy();
});

test("expose port: pool exhaustion → 409", async () => {
  const { app, db } = await mk({ env: { DROP_TCP_PORT_RANGE: "7000-7000" } }); // a one-port pool
  await call(app, "POST", "/v1/apps/a", "alice", { image: "x:1", scale: { min: 1, max: 1 } });
  await call(app, "POST", "/v1/apps/b", "alice", { image: "x:1", scale: { min: 1, max: 1 } });
  expect((await call(app, "POST", "/v1/sites/a/expose", "alice", { mode: "port" })).status).toBe(200);
  const res = await call(app, "POST", "/v1/sites/b/expose", "alice", { mode: "port" });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/exhausted/);
  await db.destroy();
});

test("unexpose: clears the row, re-applies tenant manifests WITHOUT the allow policy, audits", async () => {
  const { app, kube, audit, db } = await mk();
  await call(app, "POST", "/v1/apps/cache", "alice", { image: "redis:1", scale: { min: 1, max: 1 } });
  await call(app, "POST", "/v1/sites/cache/expose", "alice", { mode: "port", protocol: "redis" });
  const res = await call(app, "DELETE", "/v1/sites/cache/expose", "alice");
  expect(res.status).toBe(200);
  expect((await res.json()).tcp).toBeNull();
  // tenant re-applied with NO edge-tcp policies (the allow rule is pruned)
  const lastTenant = kube.tenantApplies[kube.tenantApplies.length - 1]!.manifests as any;
  expect(lastTenant.edgeTcpPolicies).toEqual([]);
  // the edge-tcp Service was patched back to just the shared port
  const patch = kube.edgeTcpPortPatches[kube.edgeTcpPortPatches.length - 1]!;
  expect(patch.ports.map((p) => p.port)).toEqual([5432]);
  // the detail no longer surfaces tcp
  const detail = await (await call(app, "GET", "/v1/sites/cache", "alice")).json();
  expect(detail.tcp).toBeUndefined();
  expect((await audit.list({ action: "tcp.unexpose" })).entries[0]).toMatchObject({ target: "cache" });
  await db.destroy();
});

test("expose: not allowed on a static site (409)", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "mysite", await tgz({ "index.html": "x" }));
  const res = await call(app, "POST", "/v1/sites/mysite/expose", "alice", { mode: "sni" });
  expect(res.status).toBe(409);
  await db.destroy();
});

test("expose: non-deployer is 403; unknown workload 404", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/cache", "alice", { image: "x:1", scale: { min: 1, max: 1 } });
  expect((await call(app, "POST", "/v1/sites/cache/expose", "bob", { mode: "sni" })).status).toBe(403);
  expect((await call(app, "POST", "/v1/sites/ghost/expose", "alice", { mode: "sni" })).status).toBe(404);
  await db.destroy();
});

test("deploy: a protocol:tcp service is 400 WITHOUT an expose row, allowed WITH one (expose-first ordering)", async () => {
  const { app, db } = await mk();
  // first a plain HTTP deploy (scale.min>=1) claims the app
  await call(app, "POST", "/v1/apps/broker", "alice", { image: "mqtt:1", scale: { min: 1, max: 1 } });
  // redeploy declaring a tcp service, no expose row yet → assertHttpOnly 400
  const tcpCfg = { image: "mqtt:2", scale: { min: 1, max: 1 }, services: [{ internal_port: 1883, protocol: "tcp" }] };
  expect((await call(app, "POST", "/v1/apps/broker", "alice", tcpCfg)).status).toBe(400);
  // expose, then the tcp-service deploy is accepted
  expect((await call(app, "POST", "/v1/sites/broker/expose", "alice", { mode: "sni" })).status).toBe(200);
  const ok = await call(app, "POST", "/v1/apps/broker", "alice", tcpCfg);
  expect(ok.status).toBe(200);
  await db.destroy();
});

test("deploy: a TCP-exposed app deployed with scale.min=0 → 400 (enforced at deploy too)", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/broker", "alice", { image: "mqtt:1", scale: { min: 1, max: 1 } });
  await call(app, "POST", "/v1/sites/broker/expose", "alice", { mode: "sni" });
  const res = await call(app, "POST", "/v1/apps/broker", "alice", { image: "mqtt:2", scale: { min: 0, max: 3 }, services: [{ internal_port: 1883, protocol: "tcp" }] });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/scale\.min >= 1/);
  await db.destroy();
});

test("expose ls: lists the caller's exposures with connect strings", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/databases/pg", "alice", {});
  await call(app, "POST", "/v1/apps/cache", "alice", { image: "redis:1", scale: { min: 1, max: 1 } });
  await call(app, "POST", "/v1/sites/pg/expose", "alice", { mode: "sni" });
  await call(app, "POST", "/v1/sites/cache/expose", "alice", { mode: "port", protocol: "redis" });
  const res = await (await call(app, "GET", "/v1/expose", "alice")).json();
  const byName = Object.fromEntries(res.exposed.map((e: any) => [e.name, e]));
  expect(byName.pg).toMatchObject({ mode: "sni", connect: "pg.drop.example.com:5432" });
  expect(byName.cache).toMatchObject({ mode: "port", connect: "drop.example.com:7000" });
  await db.destroy();
});

test("expose with compute off: records the registry row + returns a provisioning-deferred note", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com", DROP_S3_ENDPOINT: "http://localhost:4566" });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  // No kube → compute off. Claim a DB row directly (the compute-off deploy path isn't needed here).
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  await users.upsertOnLogin("alice@example.com", null);
  const org = await orgs.ensurePersonalOrg("alice@example.com");
  await meta.claimSite("pg", "alice@example.com", "database", { id: org.id, namespace: org.namespace });
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs, audit: new AuditStore(db) }); // no kube
  const res = await call(app, "POST", "/v1/sites/pg/expose", "alice", { mode: "sni" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tcp.connect).toBe("pg.drop.example.com:5432");
  expect(body.note).toMatch(/compute off/);
  await db.destroy();
});

// ---- service accounts / scoped CI tokens (J1) --------------------------------------------------

// alice owns team org "acme" with app "myapp"; returns the created token secret + its org.
async function acmeWithToken(scopes: string[]) {
  const ctx = await mk();
  const { app } = ctx;
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/myapp?org=acme", "alice", { image: "x:1" })).status).toBe(200);
  const cr = await call(app, "POST", "/v1/orgs/acme/tokens", "alice", { name: "ci", scopes });
  expect(cr.status).toBe(200);
  const token = (await cr.json()).token as string;
  return { ...ctx, token };
}

test("token create returns the secret ONCE + is audited; list carries no hash/secret", async () => {
  const { app, audit, db } = await acmeWithToken(["deploy:myapp"]);
  const cr = await call(app, "POST", "/v1/orgs/acme/tokens", "alice", { name: "ci2", scopes: ["publish:*"] });
  const body = await cr.json();
  expect(body.token).toMatch(/^drop_st_/); // secret returned once
  expect(body.token_hash).toBeUndefined();
  // audited as token.create
  const a = await audit.list({ action: "token.create" });
  expect(a.entries.length).toBeGreaterThanOrEqual(1);
  expect(a.entries[0]!.actor).toBe("alice@example.com");
  expect(a.entries[0]!.targetType).toBe("token");
  // list never leaks the hash or the secret
  const list = await (await call(app, "GET", "/v1/orgs/acme/tokens", "alice")).json();
  expect(list.tokens.length).toBe(2);
  for (const t of list.tokens) {
    expect(t.token).toBeUndefined();
    expect(t.token_hash).toBeUndefined();
    expect(Array.isArray(t.scopes)).toBe(true);
  }
  await db.destroy();
});

test("token create: bad scope → 400; only org owner/admin may mint (stranger → 403)", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  expect((await call(app, "POST", "/v1/orgs/acme/tokens", "alice", { name: "x", scopes: ["frobnicate"] })).status).toBe(400);
  expect((await call(app, "POST", "/v1/orgs/acme/tokens", "alice", { name: "x", scopes: [] })).status).toBe(400);
  // bob is not a member of acme → 403
  expect((await call(app, "POST", "/v1/orgs/acme/tokens", "bob", { name: "x", scopes: ["read"] })).status).toBe(403);
  await db.destroy();
});

test("token-authed deploy: allowed by scope, forbidden outside scope + outside org", async () => {
  const { app, token, db } = await acmeWithToken(["deploy:myapp"]);
  // in-scope deploy of the existing app → 200
  expect((await call(app, "POST", "/v1/apps/myapp", token, { image: "x:2" })).status).toBe(200);
  // another app in the SAME org but not in scope → 403
  expect((await call(app, "POST", "/v1/apps/other?org=acme", "alice", { image: "x:1" })).status).toBe(200); // alice creates it
  expect((await call(app, "POST", "/v1/apps/other", token, { image: "x:2" })).status).toBe(403); // scope is deploy:myapp only
  // an app in a DIFFERENT org (alice's personal) → cross-org deny 403
  expect((await call(app, "POST", "/v1/apps/solo", "alice", { image: "x:1" })).status).toBe(200); // personal org
  expect((await call(app, "POST", "/v1/apps/solo", token, { image: "x:2" })).status).toBe(403);
  await db.destroy();
});

test("token is NEVER admin/org-management-capable, and cannot mint tokens", async () => {
  const { app, token, db } = await acmeWithToken(["deploy:myapp"]);
  expect((await call(app, "GET", "/v1/admin/users", token)).status).toBe(403); // admin surface
  expect((await call(app, "POST", "/v1/orgs/acme/members", token, { email: "eve@x.com", role: "member" })).status).toBe(403); // org management
  expect((await call(app, "POST", "/v1/orgs/acme/tokens", token, { name: "evil", scopes: ["deploy:*"] })).status).toBe(403); // can't mint tokens
  await db.destroy();
});

test("token cannot claim a NEW resource, and minting no phantom user for the token principal", async () => {
  const { app, token, users, db } = await acmeWithToken(["deploy:*"]);
  // deploying a not-yet-created name → 403 (tokens act on existing resources only)
  expect((await call(app, "POST", "/v1/apps/brandnew?org=acme", token, { image: "x:1" })).status).toBe(403);
  // and no `token:ci@acme` user row was ever created (it must not appear in admin user lists)
  expect(await users.getUser("token:ci@acme")).toBeNull();
  await db.destroy();
});

test("revoke: a revoked token stops authenticating (subsequent request → 401)", async () => {
  const { app, token, db } = await acmeWithToken(["deploy:myapp"]);
  expect((await call(app, "POST", "/v1/apps/myapp", token, { image: "x:2" })).status).toBe(200);
  const list = await (await call(app, "GET", "/v1/orgs/acme/tokens", "alice")).json();
  const id = list.tokens[0]!.id as string;
  const rev = await call(app, "DELETE", `/v1/orgs/acme/tokens/${id}`, "alice");
  expect(rev.status).toBe(200);
  // subsequent use of the revoked secret → 401 at the auth boundary
  expect((await call(app, "POST", "/v1/apps/myapp", token, { image: "x:3" })).status).toBe(401);
  await db.destroy();
});

// ---- previews (E1) -------------------------------------------------------------------------------

const pubPreview = (app: any, tok: string, name: string, label: string, body: Buffer, expireDays?: number) => {
  const q = new URLSearchParams({ preview: label });
  if (expireDays != null) q.set("expire_days", String(expireDays));
  return app.request(`/v1/sites/${name}/versions?${q.toString()}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/gzip" },
    body,
  });
};

test("preview publish: creates a version but leaves current_version UNTOUCHED; the row is upserted; audited", async () => {
  const { app, meta, audit, db } = await mk();
  expect((await pub(app, "alice", "myapp", await tgz({ "index.html": "v1" }))).status).toBe(200);
  const before = (await meta.getSitePlain("myapp"))!.currentVersion;

  const res = await pubPreview(app, "alice", "myapp", "pr-1", await tgz({ "index.html": "preview-bytes" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.preview.label).toBe("pr-1");
  expect(body.preview.url).toBe("https://myapp--pr-1.drop.example.com");
  expect(typeof body.preview.expiresAt).toBe("string");

  const after = (await meta.getSitePlain("myapp"))!.currentVersion;
  expect(after).toBe(before); // current_version untouched

  const list = await meta.listVersions("myapp");
  expect(list.some((v) => v.id === body.preview.versionId)).toBe(true); // the version WAS stored

  // re-publishing the SAME label re-points it (upsert), not a second row
  const res2 = await pubPreview(app, "alice", "myapp", "pr-1", await tgz({ "index.html": "preview-bytes-2" }));
  const body2 = await res2.json();
  const previewsResp = await (await call(app, "GET", "/v1/sites/myapp/previews", "alice")).json();
  expect(previewsResp.previews).toHaveLength(1);
  expect(previewsResp.previews[0].versionId).toBe(body2.preview.versionId);

  const entries = (await audit.list({ action: "preview.create" })).entries;
  expect(entries.length).toBe(2); // one per publish (re-point still audits)
  expect(entries[0]!.target).toBe("myapp");
  expect(entries[0]!.detail).toMatchObject({ label: "pr-1" });
  await db.destroy();
});

test("preview publish: label validation 400s (before the upload is even read)", async () => {
  const { app, db } = await mk();
  for (const bad of ["", "-abc", "abc-", "Abc", "a".repeat(21), "pr--1"]) {
    const res = await pubPreview(app, "alice", "myapp", bad, await tgz({ "index.html": "x" }));
    expect(res.status).toBe(400);
  }
  await db.destroy();
});

test("preview publish: ?expire_days is honored within range, clamped outside it", async () => {
  const { app, db } = await mk();
  const days = async (label: string, n?: number) => {
    const res = await pubPreview(app, "alice", "myapp", label, await tgz({ "index.html": "x" }), n);
    const body = await res.json();
    return (new Date(body.preview.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  };
  expect(await days("a", 3)).toBeCloseTo(3, 0); // honored
  expect(await days("b", 0)).toBeCloseTo(1, 0); // clamped up to the 1-day floor
  expect(await days("c", 999)).toBeCloseTo(30, 0); // clamped down to the 30-day ceiling
  expect(await days("d", undefined)).toBeCloseTo(7, 0); // default
  await db.destroy();
});

test("preview rm: removes it (audited); unknown label 404; same authz tier as publish", async () => {
  const { app, audit, db } = await mk();
  await pubPreview(app, "alice", "myapp", "pr-1", await tgz({ "index.html": "x" }));
  expect((await call(app, "DELETE", "/v1/sites/myapp/previews/nope", "alice")).status).toBe(404);
  const rm = await call(app, "DELETE", "/v1/sites/myapp/previews/pr-1", "alice");
  expect(rm.status).toBe(200);
  expect((await rm.json()).removed).toBe(true);
  // it's gone
  const list = await (await call(app, "GET", "/v1/sites/myapp/previews", "alice")).json();
  expect(list.previews).toHaveLength(0);
  const entries = (await audit.list({ action: "preview.delete" })).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]!.detail).toMatchObject({ label: "pr-1" });
  // viewer (read-only) cannot remove — publish tier required
  await pubPreview(app, "alice", "myapp", "pr-2", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/sites/myapp/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  expect((await call(app, "DELETE", "/v1/sites/myapp/previews/pr-2", "bob")).status).toBe(403);
  await db.destroy();
});

test("preview GET is embedded in the site detail response too", async () => {
  const { app, db } = await mk();
  await pubPreview(app, "alice", "myapp", "pr-1", await tgz({ "index.html": "x" }));
  const detail = await (await call(app, "GET", "/v1/sites/myapp", "alice")).json();
  expect(detail.previews).toHaveLength(1);
  expect(detail.previews[0].label).toBe("pr-1");
  await db.destroy();
});

// ---- (G2 / G2b) metrics + uptime routes + Prometheus scrape ----------------------------------
import { MetricsStore } from "../metrics/store.ts";

const nowMinute = () => new Date(Math.floor(Date.now() / 60_000) * 60_000);

test("G2 metrics route: owner reads {range, series, totals}; range param honored", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  const ms = new MetricsStore(db);
  await ms.flushTraffic(nowMinute(), [
    { siteName: "myapp", requests: 10, bytesIn: 0, bytesOut: 500, p50Ms: 20, p95Ms: 120, s2xx: 8, s4xx: 1, s5xx: 1 },
  ]);
  const res = await call(app, "GET", "/v1/sites/myapp/metrics", "alice");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.range).toBe("1h");
  expect(body.totals.requests).toBe(10);
  expect(body.totals.errors).toBe(2);
  expect(body.totals.p95).toBe(120);
  expect(body.series.length).toBeGreaterThanOrEqual(1);
  const wide = await (await call(app, "GET", "/v1/sites/myapp/metrics?range=7d", "alice")).json();
  expect(wide.range).toBe("7d");
  await db.destroy();
});

test("G2 metrics route: authz — non-member 403, unknown site 404", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  expect((await call(app, "GET", "/v1/sites/myapp/metrics", "bob")).status).toBe(403);
  expect((await call(app, "GET", "/v1/sites/ghost/metrics", "alice")).status).toBe(404);
  await db.destroy();
});

test("G2b uptime route + detail summary: last-24h % and lastCheck", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  const ms = new MetricsStore(db);
  await ms.recordUptime("myapp", nowMinute(), { ok: true, latencyMs: 40, status: 200 });
  const res = await call(app, "GET", "/v1/sites/myapp/uptime", "alice");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.range).toBe("24h");
  expect(body.checks).toHaveLength(1);
  expect(body.summary.last24hPct).toBe(100);
  expect(body.summary.lastCheck.status).toBe(200);
  // the same summary is embedded in the site detail response
  const detail = await (await call(app, "GET", "/v1/sites/myapp", "alice")).json();
  expect(detail.uptime.last24hPct).toBe(100);
  await db.destroy();
});

test("G2 Prometheus /metrics: admin-gated, text format", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  const ms = new MetricsStore(db);
  await ms.flushTraffic(nowMinute(), [
    { siteName: "myapp", requests: 7, bytesIn: 0, bytesOut: 99, p50Ms: 5, p95Ms: 50, s2xx: 7, s4xx: 0, s5xx: 0 },
  ]);
  const unauth = await app.request("/metrics");
  expect(unauth.status).toBe(401);
  expect((await call(app, "GET", "/metrics", "bob")).status).toBe(403); // not an admin
  const ok = await call(app, "GET", "/metrics", "alice");
  expect(ok.status).toBe(200);
  const text = await ok.text();
  expect(text).toContain('drop_edge_requests{site="myapp"} 7');
  await db.destroy();
});

// ---- (M2) capabilities API + org member role change -------------------------------------------

test("(M2) detail + list carry capabilities; owner is full, editor is ship-tier (no configure/delete)", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  // owner: the full verb set
  const owner = await (await call(app, "GET", "/v1/sites/myapp", "alice")).json();
  expect(Array.isArray(owner.capabilities)).toBe(true);
  expect(owner.capabilities).toContain("delete");
  expect(owner.capabilities).toContain("configure");
  expect(owner.capabilities).toContain("publish");
  // the LIST carries capabilities too
  const list = await (await call(app, "GET", "/v1/sites", "alice")).json();
  const item = list.sites.find((s: any) => s.name === "myapp");
  expect(item.capabilities).toContain("publish");
  // bob as editor: ship tier — deploy/publish yes, configure/delete no
  await call(app, "POST", "/v1/sites/myapp/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  const ed = await (await call(app, "GET", "/v1/sites/myapp", "bob")).json();
  expect(ed.capabilities).toContain("deploy");
  expect(ed.capabilities).toContain("publish");
  expect(ed.capabilities).not.toContain("configure");
  expect(ed.capabilities).not.toContain("delete");
  await db.destroy();
});

test("(M2) a viewer's capabilities are read-only (no deploy)", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/sites/myapp/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  const v = await (await call(app, "GET", "/v1/sites/myapp", "bob")).json();
  expect(v.capabilities).toEqual(["read"]);
  expect(v.capabilities).not.toContain("deploy");
  await db.destroy();
});

test("(M2) a service token's capabilities are scope-filtered on detail", async () => {
  const { app, token, db } = await acmeWithToken(["read:myapp", "deploy:myapp", "logs:myapp"]);
  const d = await (await call(app, "GET", "/v1/sites/myapp", token)).json();
  expect([...d.capabilities].sort()).toEqual(["deploy", "logs", "read"]);
  expect(d.capabilities).not.toContain("delete");
  expect(d.capabilities).not.toContain("configure");
  await db.destroy();
});

test("(M2) org member role change: owner/admin only, founding owner immutable, owner not assignable", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" });
  await call(app, "POST", "/v1/orgs/acme/members", "alice", { email: "bob@example.com", role: "member" });
  // owner promotes bob member → admin
  const up = await call(app, "PATCH", "/v1/orgs/acme/members/bob@example.com", "alice", { role: "admin" });
  expect(up.status).toBe(200);
  expect((await up.json()).role).toBe("admin");
  // reflected on the org detail roster
  const det = await (await call(app, "GET", "/v1/orgs/acme", "alice")).json();
  expect(det.members.find((m: any) => m.email === "bob@example.com").role).toBe("admin");
  // "owner" is not assignable (single-owner invariant) → 400
  expect((await call(app, "PATCH", "/v1/orgs/acme/members/bob@example.com", "alice", { role: "owner" })).status).toBe(400);
  // the founding owner is immutable → 409
  expect((await call(app, "PATCH", "/v1/orgs/acme/members/alice@example.com", "alice", { role: "member" })).status).toBe(409);
  // a plain member can't change roles → 403
  await call(app, "PATCH", "/v1/orgs/acme/members/bob@example.com", "alice", { role: "member" });
  expect((await call(app, "PATCH", "/v1/orgs/acme/members/alice@example.com", "bob", { role: "viewer" })).status).toBe(403);
  // changing a non-member → 404
  expect((await call(app, "PATCH", "/v1/orgs/acme/members/nobody@example.com", "alice", { role: "member" })).status).toBe(404);
  await db.destroy();
});

// ============================ (E2) app previews ============================
// A preview deploy (`?preview=<label>`) builds a PARALLEL `<name>-p-<label>` manifest set at
// <name>--<label>, scale forced {0,1}, reusing the parent's secrets/bindings read-only, and NEVER
// touches the parent's current_version or its manifests.

test("(E2) deploy ?preview: parallel suffixed manifest set, --host, forced scale {0,1}, parent secret refs; parent untouched", async () => {
  const { app, kube, meta, db } = await mk();
  expect((await call(app, "POST", "/v1/apps/web", "alice", { image: "web:1", scale: { min: 1, max: 3 } })).status).toBe(200);
  const before = (await meta.getSitePlain("web"))!.currentVersion;
  const res = await call(app, "POST", "/v1/apps/web?preview=pr1", "alice", { image: "web:2" });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.preview).toMatchObject({ label: "pr1", url: "https://web--pr1.drop.example.com", image: "web:2", withDb: false });
  // parent's current_version + manifests are UNTOUCHED (no new apply for `web`, version unchanged)
  expect((await meta.getSitePlain("web"))!.currentVersion).toBe(before);
  expect(kube.applies.filter((a) => a.name === "web").length).toBe(1);
  // the preview workload was applied under the suffixed name with the forced scale + host
  const pv = kube.applies.find((a) => a.name === "web-p-pr1")!;
  expect(pv).toBeTruthy();
  const hso = pv.manifests.httpScaledObject as any;
  expect(hso.spec.hosts).toEqual(["web--pr1.drop.example.com"]);
  expect(hso.spec.replicas).toEqual({ min: 0, max: 1 });
  expect((pv.manifests.deployment as any).spec.template.metadata.annotations["drop.dev/version"]).toBeTruthy();
  // read-only secret reuse: envFrom references the PARENT's write-only `web-secret`, not `web-p-pr1-secret`
  expect((pv.manifests.deployment as any).spec.template.spec.containers[0].envFrom).toEqual([{ secretRef: { name: "web-secret", optional: true } }]);
  expect(pv.manifests.secret).toBeUndefined(); // no per-preview -env
  // surfaced on the parent app's detail (previews present for type=app)
  const det = await (await call(app, "GET", "/v1/sites/web", "alice")).json();
  expect(det.previews).toHaveLength(1);
  expect(det.previews[0]).toMatchObject({ label: "pr1", url: "https://web--pr1.drop.example.com", kind: "app", hasDb: false });
  await db.destroy();
});

test("(E2) preview of an app that was never deployed → 404", async () => {
  const { app, db } = await mk();
  const res = await call(app, "POST", "/v1/apps/ghost?preview=pr1", "alice", { image: "g:1" });
  expect(res.status).toBe(404);
  await db.destroy();
});

test("(E2) deploy ?preview&with_db clones a SEPARATE empty CNPG cluster from the parent db spec; the preview uses the clone", async () => {
  const { app, kube, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const parentDb = kube.dbApplies.find((a) => a.name === "appdb")!;
  const res = await call(app, "POST", "/v1/apps/web?org=acme&preview=pr1&with_db=true", "alice", { image: "web:1", uses: [{ database: "appdb" }] });
  expect(res.status).toBe(200);
  expect((await res.json()).preview).toMatchObject({ withDb: true, db: "web-p-pr1-db" });
  // a FRESH, SEPARATE cluster (its own creds Secret ⇒ empty init) cloning the parent db's SPEC
  const clone = kube.dbApplies.find((a) => a.name === "web-p-pr1-db")!;
  expect(clone).toBeTruthy();
  expect(clone.manifests.appSecret).toBeTruthy(); // creds set once → a fresh empty database (not a data copy)
  expect((clone.manifests.cluster as any).spec.storage.size).toBe((parentDb.manifests.cluster as any).spec.storage.size); // cloned spec
  // the preview app binds the CLONE's creds/CA — never the parent's appdb-app
  const pv = kube.applies.find((a) => a.name === "web-p-pr1")!;
  const ctr = (pv.manifests.deployment as any).spec.template.spec.containers[0];
  expect(ctr.envFrom[0]).toEqual({ secretRef: { name: "web-p-pr1-db-app" } });
  expect(ctr.env).toContainEqual({ name: "PGSSLROOTCERT", value: "/var/run/drop/db-ca/web-p-pr1-db/ca.crt" });
  await db.destroy();
});

test("(E2) --with-db on an app with no bound database → 400", async () => {
  const { app, db } = await mk();
  expect((await call(app, "POST", "/v1/apps/web", "alice", { image: "web:1" })).status).toBe(200);
  const res = await call(app, "POST", "/v1/apps/web?preview=pr1&with_db=true", "alice", { image: "web:1" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("--with-db");
  await db.destroy();
});

test("(E2) an app preview counts against the org workload cap → 429 when full", async () => {
  const { app, db } = await mk({ env: { DROP_MAX_WORKLOADS_PER_ORG: "1" } });
  expect((await call(app, "POST", "/v1/apps/web", "alice", { image: "web:1" })).status).toBe(200); // fills the cap (1 site)
  const res = await call(app, "POST", "/v1/apps/web?preview=pr1", "alice", { image: "web:1" });
  expect(res.status).toBe(429);
  expect((await res.json()).error).toContain("workload cap");
  await db.destroy();
});

test("(E2) re-deploying the SAME preview label re-points it (no second workload counted) and doesn't re-rotate the db clone", async () => {
  // cap 3 = 2 sites (db + app) + room for exactly ONE preview; a re-point of that label mustn't count again.
  const { app, kube, db } = await mk({ env: { DROP_MAX_WORKLOADS_PER_ORG: "3" } });
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200); // site 1
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200); // site 2
  // a first preview label is allowed (previews aren't sites); a second deploy of the SAME label is a re-point
  expect((await call(app, "POST", "/v1/apps/web?org=acme&preview=pr1&with_db=true", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme&preview=pr1&with_db=true", "alice", { image: "web:2", uses: [{ database: "appdb" }] })).status).toBe(200);
  // the db clone keeps its creds (appSecret only on the FIRST apply — a re-apply must not re-rotate)
  const cloneApplies = kube.dbApplies.filter((a) => a.name === "web-p-pr1-db");
  expect(cloneApplies).toHaveLength(2);
  expect(cloneApplies[0]!.manifests.appSecret).toBeTruthy();
  expect(cloneApplies[1]!.manifests.appSecret).toBeUndefined();
  await db.destroy();
});

test("(E2) preview rm tears down the app preview's manifest set + its --with-db clone + the row", async () => {
  const { app, kube, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme&preview=pr1&with_db=true", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const rm = await call(app, "DELETE", "/v1/sites/web/previews/pr1", "alice");
  expect(rm.status).toBe(200);
  expect(kube.deletes.some((x) => x.name === "web-p-pr1")).toBe(true); // parallel workload torn down
  expect(kube.dbDeletes.some((x) => x.name === "web-p-pr1-db")).toBe(true); // the empty clone too
  const det = await (await call(app, "GET", "/v1/sites/web", "alice")).json();
  expect(det.previews).toHaveLength(0); // row gone
  await db.destroy();
});

test("(E2) a non-owner cannot create or remove an app preview (deploy-gated)", async () => {
  const { app, db } = await mk();
  expect((await call(app, "POST", "/v1/apps/web", "alice", { image: "web:1" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?preview=pr1", "bob", { image: "web:1" })).status).toBe(403);
  expect((await call(app, "POST", "/v1/apps/web?preview=pr1", "alice", { image: "web:1" })).status).toBe(200);
  expect((await call(app, "DELETE", "/v1/sites/web/previews/pr1", "bob")).status).toBe(403);
  await db.destroy();
});

// ============================ (L2) database branching for previews ============================
// `--from-backup` makes the --with-db clone a RECOVERY branch of the parent db's Barman backup (a full
// copy of prod data) instead of an empty clone. Governance: the parent DB's manage tier; audited
// db.branch; storage full-copy budget; point-in-time via --at; the branch reads the backup, not the
// live volume; it dies with the preview.

// Preset one completed base backup on the parent db so the recovery guard passes.
function seedParentBackup(kube: any, ns: string, dbName: string) {
  kube.backupsByDb.set(`${ns}/${dbName}`, [{ name: `${dbName}-b1`, phase: "completed", method: "plugin", startedAt: "2026-06-01T02:00:00Z", stoppedAt: "2026-06-01T02:01:00Z", error: null }]);
}

test("(L2) deploy ?preview&with_db&from_backup branches via bootstrap.recovery from the parent backup; provenance + audit + redirected uses", async () => {
  const { app, kube, audit, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const ns = kube.dbApplies.find((a: any) => a.name === "appdb")!.namespace;
  seedParentBackup(kube, ns, "appdb");
  const res = await call(app, "POST", "/v1/apps/web?org=acme&preview=pr1&with_db=true&from_backup=true", "alice", { image: "web:1", uses: [{ database: "appdb" }] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.preview).toMatchObject({ withDb: true, db: "web-p-pr1-db", branchedFrom: "appdb" });
  expect(typeof body.preview.branchedAt).toBe("string"); // latest → the branch-creation time
  // the preview db is RECOVERY-bootstrapped (not empty init), reading the SOURCE's object store
  const clone = kube.dbApplies.find((a: any) => a.name === "web-p-pr1-db")!;
  const spec = (clone.manifests.cluster as any).spec;
  expect(spec.bootstrap.recovery).toBeDefined();
  expect(spec.bootstrap.initdb).toBeUndefined();
  expect(spec.externalClusters[0].plugin.parameters.serverName).toBe("appdb");
  expect((clone.manifests as any).sourceObjectStore.spec.configuration.destinationPath).toContain("/appdb");
  expect(clone.manifests.appSecret).toBeTruthy(); // the branch's OWN generated app password
  // the preview app is redirected to the BRANCH's creds (not the parent appdb's)
  const pv = kube.applies.find((a: any) => a.name === "web-p-pr1")!;
  expect((pv.manifests.deployment as any).spec.template.spec.containers[0].envFrom[0]).toEqual({ secretRef: { name: "web-p-pr1-db-app" } });
  // audited db.branch WITH the source db + the point-in-time
  const { entries } = await audit.list({ action: "db.branch", target: "web-p-pr1-db" });
  expect(entries).toHaveLength(1);
  expect(entries[0]!.detail?.sourceDb).toBe("appdb");
  expect(entries[0]!.detail?.targetTime).toBe("latest");
  await db.destroy();
});

test("(L2) --at renders a point-in-time recoveryTarget and records it on the branch + audit", async () => {
  const { app, kube, audit, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const ns = kube.dbApplies.find((a: any) => a.name === "appdb")!.namespace;
  seedParentBackup(kube, ns, "appdb");
  const at = "2026-07-01T12:00:00.000Z";
  const res = await call(app, "POST", `/v1/apps/web?org=acme&preview=pr1&with_db=true&from_backup=true&at=${encodeURIComponent(at)}`, "alice", { image: "web:1", uses: [{ database: "appdb" }] });
  expect(res.status).toBe(200);
  expect((await res.json()).preview.branchedAt).toBe(at);
  const clone = kube.dbApplies.find((a: any) => a.name === "web-p-pr1-db")!;
  expect((clone.manifests.cluster as any).spec.bootstrap.recovery.recoveryTarget.targetTime).toBe(at);
  expect((await audit.list({ action: "db.branch", target: "web-p-pr1-db" })).entries[0]!.detail?.targetTime).toBe(at);
  await db.destroy();
});

test("(L2) --at requires --from-backup; --from-backup requires --with-db; a bad --at → 400", async () => {
  const { app, db } = await mk();
  expect((await call(app, "POST", "/v1/apps/web", "alice", { image: "web:1" })).status).toBe(200);
  // --from-backup without --with-db → 400 (flag-shape validation fires before any db binding is needed)
  const r1 = await call(app, "POST", "/v1/apps/web?preview=p1&from_backup=true", "alice", { image: "web:1" });
  expect(r1.status).toBe(400);
  expect((await r1.json()).error).toContain("--from-backup requires --with-db");
  // --at without --from-backup → 400
  const r2 = await call(app, "POST", "/v1/apps/web?preview=p2&with_db=true&at=2026-07-01T00:00:00Z", "alice", { image: "web:1" });
  expect(r2.status).toBe(400);
  expect((await r2.json()).error).toContain("--at");
  // a malformed --at → 400
  const r3 = await call(app, "POST", "/v1/apps/web?preview=p3&with_db=true&from_backup=true&at=not-a-date", "alice", { image: "web:1" });
  expect(r3.status).toBe(400);
  expect((await r3.json()).error).toContain("invalid --at");
  await db.destroy();
});

test("(L2) governance: branching prod data needs manage (db:create) on the PARENT db, not just deploy on the app → 403", async () => {
  const { app, kube, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const ns = kube.dbApplies.find((a: any) => a.name === "appdb")!.namespace;
  seedParentBackup(kube, ns, "appdb");
  // bob is a per-site EDITOR on the APP only (deploy ✓) — never a member of appdb, never an org member
  // (so no db:create on the parent db). This is exactly the actor the governance gate must stop.
  await call(app, "POST", "/v1/sites/web/collaborators", "alice", { email: "bob@example.com", role: "editor" });
  // bob CAN make an empty --with-db clone (E2 rule: deploy on the app is enough; no prod data moves)…
  expect((await call(app, "POST", "/v1/apps/web?org=acme&preview=empty&with_db=true", "bob", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  // …but he CANNOT branch prod data from backup — 403, and no branch cluster is applied
  const res = await call(app, "POST", "/v1/apps/web?org=acme&preview=branch&with_db=true&from_backup=true", "bob", { image: "web:1", uses: [{ database: "appdb" }] });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain("db:create");
  expect(kube.dbApplies.some((a: any) => a.name === "web-p-branch-db")).toBe(false);
  // alice (org owner ⇒ db:create on appdb) CAN branch it
  expect((await call(app, "POST", "/v1/apps/web?org=acme&preview=branch&with_db=true&from_backup=true", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  await db.destroy();
});

test("(L2) a branch is a FULL COPY — it counts against the org storage budget → 429 when over", async () => {
  const { app, kube, db } = await mk({ admins: ["alice@example.com"] });
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "team", name: "Team" })).status).toBe(200);
  await call(app, "PUT", "/v1/admin/orgs/team/quotas", "alice", { quotas: { storage_budget_bytes: "1536Mi" } }); // 1.5Gi
  expect((await call(app, "POST", "/v1/databases/appdb?org=team", "alice", { storage: "1Gi" })).status).toBe(200); // parent uses 1Gi (< 1.5Gi)
  expect((await call(app, "POST", "/v1/apps/web?org=team", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const ns = kube.dbApplies.find((a: any) => a.name === "appdb")!.namespace;
  seedParentBackup(kube, ns, "appdb");
  // a same-size (1Gi) branch would bring the org to 2Gi > 1.5Gi budget → 429
  const res = await call(app, "POST", "/v1/apps/web?org=team&preview=pr1&with_db=true&from_backup=true", "alice", { image: "web:1", uses: [{ database: "appdb" }] });
  expect(res.status).toBe(429);
  expect((await res.json()).error).toMatch(/storage budget exceeded/);
  await db.destroy();
});

test("(L2) branching with no completed backup on the parent → 409", async () => {
  const { app, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  // no backup seeded → recovery has nothing to restore from
  const res = await call(app, "POST", "/v1/apps/web?org=acme&preview=pr1&with_db=true&from_backup=true", "alice", { image: "web:1", uses: [{ database: "appdb" }] });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("no completed backup");
  await db.destroy();
});

test("(L2) the branch dies with the preview: preview rm tears down the recovery cluster (same deleteDatabase path as the sweep)", async () => {
  const { app, kube, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const ns = kube.dbApplies.find((a: any) => a.name === "appdb")!.namespace;
  seedParentBackup(kube, ns, "appdb");
  expect((await call(app, "POST", "/v1/apps/web?org=acme&preview=pr1&with_db=true&from_backup=true", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  // removing the preview tears down the parallel workload AND the recovery-bootstrapped branch db —
  // the identical `deleteDatabase(ns, <name>-p-<label>-db)` the expiry sweep (bin/api.ts) calls.
  const rm = await call(app, "DELETE", "/v1/sites/web/previews/pr1", "alice");
  expect(rm.status).toBe(200);
  expect(kube.deletes.some((x: any) => x.name === "web-p-pr1")).toBe(true);
  expect(kube.dbDeletes.some((x: any) => x.name === "web-p-pr1-db")).toBe(true);
  const det = await (await call(app, "GET", "/v1/sites/web", "alice")).json();
  expect(det.previews).toHaveLength(0);
  await db.destroy();
});

test("(L2) the parent app detail surfaces the branch provenance (console 'branched from <db>@<ts>')", async () => {
  const { app, kube, db } = await mk();
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/appdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/apps/web?org=acme", "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const ns = kube.dbApplies.find((a: any) => a.name === "appdb")!.namespace;
  seedParentBackup(kube, ns, "appdb");
  const at = "2026-07-01T12:00:00.000Z";
  expect((await call(app, "POST", `/v1/apps/web?org=acme&preview=pr1&with_db=true&from_backup=true&at=${encodeURIComponent(at)}`, "alice", { image: "web:1", uses: [{ database: "appdb" }] })).status).toBe(200);
  const det = await (await call(app, "GET", "/v1/sites/web", "alice")).json();
  expect(det.previews[0]).toMatchObject({ label: "pr1", kind: "app", hasDb: true, branchedFrom: "appdb", branchedAt: at });
  // an EMPTY --with-db clone (or a plain preview) carries no provenance
  expect((await call(app, "POST", "/v1/apps/web?org=acme&preview=plain", "alice", { image: "web:1" })).status).toBe(200);
  const det2 = await (await call(app, "GET", "/v1/sites/web", "alice")).json();
  expect(det2.previews.find((p: any) => p.label === "plain").branchedFrom).toBeUndefined();
  await db.destroy();
});

// ---- (L4) runtime config / feature flags ------------------------------------------------------

test("(L4) config set/get: stores non-secret KV, returns map + ETag; If-None-Match → 304", async () => {
  const { app, db } = await mk();
  expect((await call(app, "POST", "/v1/apps/cfgapp", "alice", { image: "x:1" })).status).toBe(200);

  // set two keys
  expect((await call(app, "PUT", "/v1/apps/cfgapp/config/FEATURE_X", "alice", { value: "on" })).status).toBe(200);
  const put2 = await call(app, "PUT", "/v1/apps/cfgapp/config/THEME", "alice", { value: "dark" });
  expect(put2.status).toBe(200);
  expect((await put2.json()).version).toBe(2); // ETag bumps per mutation

  // get returns the map + version + a weak ETag header
  const g = await call(app, "GET", "/v1/apps/cfgapp/config", "alice");
  expect(g.status).toBe(200);
  const body = await g.json();
  expect(body).toEqual({ config: { FEATURE_X: "on", THEME: "dark" }, version: 2 });
  const etag = g.headers.get("etag");
  expect(etag).toBe('W/"2"');

  // If-None-Match with the current ETag → 304 (unchanged), no body change
  const notMod = await app.request("/v1/apps/cfgapp/config", { headers: { authorization: "Bearer alice", "if-none-match": etag! } });
  expect(notMod.status).toBe(304);

  // a stale ETag → 200 with the current map
  const stale = await app.request("/v1/apps/cfgapp/config", { headers: { authorization: "Bearer alice", "if-none-match": 'W/"1"' } });
  expect(stale.status).toBe(200);
  await db.destroy();
});

test("(L4) config: credential-looking values are REFUSED (400) — steered to the secret path", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/apps/cfgapp", "alice", { image: "x:1" });
  // secret-y KEY name
  const r1 = await call(app, "PUT", "/v1/apps/cfgapp/config/API_KEY", "alice", { value: "whatever" });
  expect(r1.status).toBe(400);
  expect((await r1.json()).error).toMatch(/drop secrets set/);
  // high-entropy VALUE under a benign key
  const r2 = await call(app, "PUT", "/v1/apps/cfgapp/config/BLOB", "alice", { value: "9aF3kQ2mZ7pL1xR8vT4wYbN6cD0eG5hJ7tWq" });
  expect(r2.status).toBe(400);
  // nothing was stored
  expect((await (await call(app, "GET", "/v1/apps/cfgapp/config", "alice")).json()).config).toEqual({});
  // an oversized value is rejected too
  const big = await call(app, "PUT", "/v1/apps/cfgapp/config/BIG", "alice", { value: "x".repeat(5000) });
  expect(big.status).toBe(400);
  await db.destroy();
});

test("(L4) config authz: mutations are configure-gated; a viewer reads but cannot set; both audited", async () => {
  const { app, audit, db } = await mk();
  await call(app, "POST", "/v1/apps/cfgapp", "alice", { image: "x:1" });
  await call(app, "POST", "/v1/sites/cfgapp/collaborators", "alice", { email: "bob@example.com", role: "viewer" });

  // a viewer can READ config (read verb) but cannot SET it (configure)
  await call(app, "PUT", "/v1/apps/cfgapp/config/K", "alice", { value: "v" });
  expect((await call(app, "GET", "/v1/apps/cfgapp/config", "bob")).status).toBe(200);
  expect((await call(app, "PUT", "/v1/apps/cfgapp/config/K", "bob", { value: "v2" })).status).toBe(403);
  expect((await call(app, "DELETE", "/v1/apps/cfgapp/config/K", "bob")).status).toBe(403);

  // set + rm are audited
  expect((await call(app, "DELETE", "/v1/apps/cfgapp/config/K", "alice")).status).toBe(200);
  expect((await audit.list({ action: "config.set", target: "cfgapp" })).entries.length).toBeGreaterThan(0);
  expect((await audit.list({ action: "config.rm", target: "cfgapp" })).entries.length).toBeGreaterThan(0);
  await db.destroy();
});

test("(L4) first config set LAZILY mints the app read token (config.read scope) + injects DROP_CONFIG_*", async () => {
  const { app, meta, secrets, tokens, db } = await mk();
  await call(app, "POST", "/v1/apps/cfgapp", "alice", { image: "x:1" });
  const site = (await meta.getSitePlain("cfgapp"))!;

  await call(app, "PUT", "/v1/apps/cfgapp/config/FEATURE_X", "alice", { value: "on" });
  // the injected env landed in the write-only secret store (not a response/log)
  const bag = secrets.values.get(`${site.namespace}/cfgapp`)!;
  expect(bag.get("DROP_CONFIG_TOKEN")).toMatch(/^drop_st_/);
  expect(bag.get("DROP_CONFIG_URL")).toContain("/v1/apps/cfgapp/config");
  // …and is registered as secret keys so the ESO/kube binding syncs it
  const keyNames = (await meta.listSecretKeys("cfgapp")).map((k) => k.key);
  expect(keyNames).toContain("DROP_CONFIG_TOKEN");
  expect(keyNames).toContain("DROP_CONFIG_URL");
  // a config-scoped service token exists in the app's org
  const orgTokens = await tokens.list(site.orgId!);
  const cfgTok = orgTokens.find((t) => t.name === "config-cfgapp");
  expect(cfgTok).toBeTruthy();
  expect(cfgTok!.scopes).toEqual(["config.read:cfgapp"]);

  // a SECOND set does NOT mint a new token (idempotent)
  await call(app, "PUT", "/v1/apps/cfgapp/config/THEME", "alice", { value: "dark" });
  expect((await tokens.list(site.orgId!)).filter((t) => t.name === "config-cfgapp")).toHaveLength(1);
  await db.destroy();
});

test("(L4) the injected app token authenticates a config GET — fenced to its own app", async () => {
  const { app, meta, tokens, db } = await mk();
  await call(app, "POST", "/v1/apps/cfgapp", "alice", { image: "x:1" });
  await call(app, "POST", "/v1/apps/other", "alice", { image: "x:1" });
  await call(app, "PUT", "/v1/apps/cfgapp/config/FEATURE_X", "alice", { value: "on" });
  const site = (await meta.getSitePlain("cfgapp"))!;

  // mint a config.read token exactly like the server does lazily, and use it as the app would
  const { token } = await tokens.create(site.orgId!, "config-cfgapp", ["config.read:cfgapp"], null, "alice@example.com");
  const asApp = await call(app, "GET", "/v1/apps/cfgapp/config", token);
  expect(asApp.status).toBe(200);
  expect((await asApp.json()).config).toEqual({ FEATURE_X: "on" });

  // the token is scoped to cfgapp only — it cannot read another app's config, nor mutate its own
  expect((await call(app, "GET", "/v1/apps/other/config", token)).status).toBe(403);
  expect((await call(app, "PUT", "/v1/apps/cfgapp/config/K", token, { value: "v" })).status).toBe(403);
  await db.destroy();
});

test("(L4) config: 404 for a missing app, 409 for a non-app, 501 mutate without compute", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "staticsite", await tgz({ "index.html": "x" })); // a site, not an app
  expect((await call(app, "GET", "/v1/apps/nope/config", "alice")).status).toBe(404);
  expect((await call(app, "GET", "/v1/apps/staticsite/config", "alice")).status).toBe(409);

  const db2 = await makeTestDb();
  const users = new UserStore(db2);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com" });
  const verifier = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const noKube = createApp({ cfg, meta: new MetaStore(db2), blob: new FakeBlob(), db: db2, users, verifier, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs: new OrgStore(db2), audit: new AuditStore(db2) }); // no kube
  expect((await call(noKube, "PUT", "/v1/apps/x/config/K", "alice", { value: "v" })).status).toBe(501);
  await db.destroy();
  await db2.destroy();
});
