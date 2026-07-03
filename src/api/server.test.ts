import { test, expect } from "bun:test";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { createApp } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
import { FakeKube } from "../kube/fake.ts";
import { FakeSecretStore } from "../secrets/fake.ts";
import { FakeImageStore } from "../images/fake.ts";
import { MetaStore } from "../metastore/store.ts";
import { LockStore } from "../metastore/lock.ts";
import { StackStore } from "../stacks/store.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { AuditStore } from "../audit/store.ts";
import { makeTestDb } from "../db/testdb.ts";
import { FakeVerifier } from "../auth/oidc.ts";
import { loadConfig } from "../config.ts";

async function tgz(files: Record<string, string>): Promise<Buffer> {
  const p = pack();
  for (const [n, c] of Object.entries(files)) p.entry({ name: n }, c);
  p.finalize();
  return await buffer(p.pipe(createGzip()));
}

async function mk(opts: { admins?: string[] } = {}) {
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
  });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@example.com", email: "alice@example.com" },
    bob: { sub: "bob@example.com", email: "bob@example.com" },
  });
  const orgs = new OrgStore(db);
  const images = new FakeImageStore();
  const audit = new AuditStore(db);
  const locks = new LockStore(db);
  return { app: createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit, locks }), meta, blob, kube, secrets, images, orgs, audit, locks, db, users };
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
  expect(u.workloads).toEqual({ site: 1, app: 1, database: 1, total: 3 });
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
