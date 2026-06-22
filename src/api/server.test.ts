import { test, expect } from "bun:test";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { createApp } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
import { FakeKube } from "../kube/fake.ts";
import { MetaStore } from "../metastore/store.ts";
import { UserStore } from "../users/store.ts";
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
  const meta = new MetaStore(db);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com" });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@example.com", email: "alice@example.com" },
    bob: { sub: "bob@example.com", email: "bob@example.com" },
  });
  return { app: createApp({ cfg, meta, blob, db, users, verifier, kube }), meta, blob, kube, db, users };
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

test("deploy: app and site names don't collide (409 both ways)", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "shared", await tgz({ "index.html": "x" })); // a site
  expect((await call(app, "POST", "/v1/apps/shared", "alice", { image: "x:1" })).status).toBe(409);
  await call(app, "POST", "/v1/apps/onlyapp", "alice", { image: "x:1" }); // an app
  expect((await pub(app, "alice", "onlyapp", await tgz({ "index.html": "x" }))).status).toBe(409);
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
  const app = createApp({ cfg, meta: new MetaStore(db), blob: new FakeBlob(), db, users, verifier }); // no kube
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
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, kube });
  expect((await call(app, "POST", "/v1/apps/billing", "upper", { image: "x:1" })).status).toBe(200);
  const site = (await meta.getSitePlain("billing"))!;
  expect(site.owner).toBe("alice@example.com"); // owner stored canonical (not "Alice@Example.com")
  // the lowercase variant is the SAME principal → owner, not a foreign 403
  expect((await call(app, "POST", "/v1/apps/billing", "lower", { image: "x:2" })).status).toBe(200);
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
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, kube });
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const np = kube.tenantApplies[0]!.manifests.networkPolicy as any;
  const https = np.spec.egress.find((e: any) => (e.ports ?? []).some((p: any) => p.port === 443));
  expect(https.to[0].ipBlock.except).toEqual(["169.254.169.254/32", "100.64.0.0/10", "172.16.0.0/12"]);
  await db.destroy();
});
