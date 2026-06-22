import { test, expect } from "bun:test";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { createApp } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
import { FakeKube } from "../kube/fake.ts";
import { FakeSecretStore } from "../secrets/fake.ts";
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
  return { app: createApp({ cfg, meta, blob, db, users, verifier, kube, secrets }), meta, blob, kube, secrets, db, users };
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
  const app = createApp({ cfg, meta: new MetaStore(db), blob: new FakeBlob(), db, users, verifier, secrets: new FakeSecretStore() }); // no kube
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
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, kube, secrets: new FakeSecretStore() });
  expect((await call(app, "POST", "/v1/apps/billing", "upper", { image: "x:1" })).status).toBe(200);
  const site = (await meta.getSitePlain("billing"))!;
  expect(site.owner).toBe("alice@example.com"); // owner stored canonical (not "Alice@Example.com")
  // the lowercase variant is the SAME principal → owner, not a foreign 403
  expect((await call(app, "POST", "/v1/apps/billing", "lower", { image: "x:2" })).status).toBe(200);
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
  const res = await call(app, "POST", "/v1/databases/billing", "alice", { storage: "20Gi", hibernation: "scheduled" });
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
  expect((m.cluster as any).spec.storage.size).toBe("20Gi");
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
  await call(app, "POST", "/v1/databases/billing", "alice", { storage: "20Gi" });
  expect((kube.dbApplies[1]!.manifests as any).appSecret).toBeUndefined();
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
  const noKube = createApp({ cfg, meta: new MetaStore(db2), blob: new FakeBlob(), db: db2, users, verifier, secrets: new FakeSecretStore() }); // no kube
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
    return { d, kube, app: createApp({ cfg, meta: new MetaStore(d), blob: new FakeBlob(), db: d, users, verifier, kube, secrets: new FakeSecretStore() }) };
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

test("read-model: list + detail + admin all carry the workload `type`", async () => {
  const { app, db } = await mk({ admins: ["alice@example.com"] });
  await pub(app, "alice", "mysite", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/apps/myapp", "alice", { image: "x:1" });
  const list = await (await call(app, "GET", "/v1/sites", "alice")).json();
  const byName = Object.fromEntries(list.sites.map((s: any) => [s.name, s.type]));
  expect(byName.mysite).toBe("site");
  expect(byName.myapp).toBe("app");
  expect((await (await call(app, "GET", "/v1/sites/myapp", "alice")).json()).type).toBe("app");
  const admin = await (await call(app, "GET", "/v1/admin/sites", "alice")).json();
  expect(admin.sites.every((s: any) => typeof s.type === "string")).toBe(true);
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
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, kube, secrets: new FakeSecretStore() });
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1" });
  const np = kube.tenantApplies[0]!.manifests.networkPolicy as any;
  const https = np.spec.egress.find((e: any) => (e.ports ?? []).some((p: any) => p.port === 443));
  expect(https.to[0].ipBlock.except).toEqual(["169.254.169.254/32", "100.64.0.0/10", "172.16.0.0/12"]);
  await db.destroy();
});
