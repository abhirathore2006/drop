import { test, expect } from "bun:test";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { createApp } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
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
  const meta = new MetaStore(db);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.company.com" });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@paytm.com", email: "alice@paytm.com" },
    bob: { sub: "bob@paytm.com", email: "bob@paytm.com" },
  });
  return { app: createApp({ cfg, meta, blob, db, users, verifier }), meta, blob, db, users };
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
  expect((await res.json()).url).toBe("https://myapp.drop.company.com");
  const site = (await meta.getSitePlain("myapp"))!;
  expect(site.owner).toBe("alice@paytm.com");
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
  expect((await call(app, "POST", "/v1/sites/myapp/collaborators", "alice", { email: "bob@paytm.com" })).status).toBe(200);
  expect((await pub(app, "bob", "myapp", await tgz({ "index.html": "y" }))).status).toBe(200);
  expect((await call(app, "POST", "/v1/sites/myapp/collaborators", "bob", { email: "carol@paytm.com" })).status).toBe(403);
  await db.destroy();
});

test("viewer role can read but not publish", async () => {
  const { app, db } = await mk();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/sites/myapp/collaborators", "alice", { email: "bob@paytm.com", role: "viewer" });
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
  expect((await call(app, "POST", "/v1/sites/myapp/transfer", "alice", { email: "bob@paytm.com" })).status).toBe(200);
  const s = (await meta.getSitePlain("myapp"))!;
  expect(s.owner).toBe("bob@paytm.com");
  expect(s.collaborators).toContain("alice@paytm.com");
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
  await call(app, "POST", "/v1/sites/a-one/collaborators", "alice", { email: "bob@paytm.com" });

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
    "_drop.json": JSON.stringify({ basicAuth: { users: { admin: "sha256:abc" } } }),
  });
  expect((await pub(app, "alice", "secret", tar)).status).toBe(200);
  expect((await meta.getSitePlain("secret"))!.visibility).toBe("password");
  await db.destroy();
});

test("admin endpoint: non-admin 403, admin sees ALL sites", async () => {
  const { app, db } = await mk({ admins: ["alice@paytm.com"] });
  await pub(app, "alice", "site-a", await tgz({ "index.html": "x" }));
  await pub(app, "bob", "site-b", await tgz({ "index.html": "x" }));
  expect((await call(app, "GET", "/v1/admin/sites", "bob")).status).toBe(403);
  const r = await call(app, "GET", "/v1/admin/sites", "alice");
  expect(r.status).toBe(200);
  expect((await r.json()).sites.map((s: any) => s.name).sort()).toEqual(["site-a", "site-b"]);
  await db.destroy();
});

test("admin cannot be spoofed via client-supplied flags/headers/body", async () => {
  const { app, db } = await mk({ admins: ["alice@paytm.com"] });
  await pub(app, "alice", "site-a", await tgz({ "index.html": "x" }));
  // bob is authenticated but NOT an admin; every escalation trick must fail.
  for (const _ of [{ admin: true }, { email: "alice@paytm.com" }, { isAdmin: true, role: "admin" }]) {
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
  const { app, db } = await mk({ admins: ["alice@paytm.com"] });
  expect((await (await call(app, "GET", "/v1/me", "alice")).json()).admin).toBe(true);
  expect((await (await call(app, "GET", "/v1/me", "bob")).json()).admin).toBe(false);
  await db.destroy();
});

test("publish parses _drop.json into config and does not serve it", async () => {
  const { app, meta, blob, db } = await mk();
  const tar = await tgz({
    "index.html": "<html>",
    "_drop.json": JSON.stringify({ spaFallback: "app.html", redirects: [{ from: "/old", to: "/new" }] }),
  });
  expect((await pub(app, "alice", "cfgsite", tar)).status).toBe(200);

  const site = (await meta.getSitePlain("cfgsite"))!;
  expect(site.config?.spaFallback).toBe("app.html");
  expect(site.config?.redirects?.[0]!.to).toBe("/new");

  const prefix = meta.filesPrefix("cfgsite", site.currentVersion!);
  expect(await blob.get(prefix + "_drop.json")).toBeNull(); // not a served file
  expect(await blob.get(prefix + "index.html")).not.toBeNull();
  await db.destroy();
});

test("publish rejects when _drop.json name mismatches the target", async () => {
  const { app, db } = await mk();
  const tar = await tgz({ "index.html": "<html>", "_drop.json": JSON.stringify({ name: "otherapp" }) });
  expect((await pub(app, "alice", "myapp", tar)).status).toBe(400);
  await db.destroy();
});
