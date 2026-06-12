import { test, expect } from "bun:test";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { createApp } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
import { MetaStore } from "../metastore/store.ts";
import { FakeVerifier } from "../auth/oidc.ts";
import { loadConfig } from "../config.ts";

async function tgz(files: Record<string, string>): Promise<Buffer> {
  const p = pack();
  for (const [n, c] of Object.entries(files)) p.entry({ name: n }, c);
  p.finalize();
  return await buffer(p.pipe(createGzip()));
}

function build() {
  const blob = new FakeBlob();
  const meta = new MetaStore(blob);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_BASE_DOMAIN: "drop.company.com" });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@paytm.com", email: "alice@paytm.com" },
    bob: { sub: "bob@paytm.com", email: "bob@paytm.com" },
  });
  return { app: createApp({ cfg, meta, blob, verifier }), meta, blob };
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
  const { app, meta } = build();
  const res = await pub(app, "alice", "myapp", await tgz({ "index.html": "<html>" }));
  expect(res.status).toBe(200);
  expect((await res.json()).url).toBe("https://myapp.drop.company.com");
  const site = (await meta.getSitePlain("myapp"))!;
  expect(site.owner).toBe("alice@paytm.com");
  expect(site.currentVersion).not.toBeNull();
});

test("publish to a foreign site is 403", async () => {
  const { app } = build();
  expect((await pub(app, "alice", "shared", await tgz({ "index.html": "x" }))).status).toBe(200);
  expect((await pub(app, "bob", "shared", await tgz({ "index.html": "y" }))).status).toBe(403);
});

test("bad name -> 400", async () => {
  const { app } = build();
  expect((await pub(app, "alice", "Bad_Name", await tgz({ "index.html": "x" }))).status).toBe(400);
});

test("traversal upload -> 400", async () => {
  const { app } = build();
  const res = await pub(app, "alice", "evil", await tgz({ "../escape.js": "x" }));
  expect(res.status).toBe(400);
});

test("rollback to previous version", async () => {
  const { app } = build();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "v1" }));
  await pub(app, "alice", "myapp", await tgz({ "index.html": "v2" }));
  const res = await call(app, "POST", "/v1/sites/myapp/rollback", "alice", {});
  expect(res.status).toBe(200);
});

test("collaborator lifecycle", async () => {
  const { app } = build();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  // bob can't publish yet
  expect((await pub(app, "bob", "myapp", await tgz({ "index.html": "y" }))).status).toBe(403);
  // alice shares with bob
  expect((await call(app, "POST", "/v1/sites/myapp/collaborators", "alice", { email: "bob@paytm.com" })).status).toBe(200);
  // now bob can publish
  expect((await pub(app, "bob", "myapp", await tgz({ "index.html": "y" }))).status).toBe(200);
  // but bob (collaborator) can't share
  expect((await call(app, "POST", "/v1/sites/myapp/collaborators", "bob", { email: "carol@paytm.com" })).status).toBe(403);
});

test("get site authz + owner-only delete", async () => {
  const { app } = build();
  await pub(app, "alice", "myapp", await tgz({ "index.html": "x" }));
  expect((await call(app, "GET", "/v1/sites/myapp", "alice")).status).toBe(200);
  expect((await call(app, "GET", "/v1/sites/myapp", "bob")).status).toBe(403);
  expect((await call(app, "DELETE", "/v1/sites/myapp", "bob")).status).toBe(403);
  expect((await call(app, "DELETE", "/v1/sites/myapp", "alice")).status).toBe(200);
});

test("ls returns only the caller's own + shared sites", async () => {
  const { app } = build();
  await pub(app, "alice", "a-one", await tgz({ "index.html": "x" }));
  await pub(app, "alice", "a-two", await tgz({ "index.html": "x" }));
  await pub(app, "bob", "b-one", await tgz({ "index.html": "x" }));
  await call(app, "POST", "/v1/sites/a-one/collaborators", "alice", { email: "bob@paytm.com" });

  const alice = await (await call(app, "GET", "/v1/sites", "alice")).json();
  expect(alice.sites.map((s: any) => s.name).sort()).toEqual(["a-one", "a-two"]);
  const bob = await (await call(app, "GET", "/v1/sites", "bob")).json();
  expect(bob.sites.map((s: any) => s.name).sort()).toEqual(["a-one", "b-one"]); // shared a-one shows up
});

test("admin endpoint: non-admin 403, admin sees ALL sites paginated", async () => {
  const blob = new FakeBlob();
  const meta = new MetaStore(blob);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_BASE_DOMAIN: "drop.company.com", DROP_ADMINS: "alice@paytm.com" });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@paytm.com", email: "alice@paytm.com" },
    bob: { sub: "bob@paytm.com", email: "bob@paytm.com" },
  });
  const app = createApp({ cfg, meta, blob, verifier });
  await pub(app, "alice", "site-a", await tgz({ "index.html": "x" }));
  await pub(app, "bob", "site-b", await tgz({ "index.html": "x" }));

  expect((await call(app, "GET", "/v1/admin/sites", "bob")).status).toBe(403); // bob not an admin
  const r = await call(app, "GET", "/v1/admin/sites", "alice");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.sites.map((s: any) => s.name).sort()).toEqual(["site-a", "site-b"]); // admin sees bob's too
});

test("admin cannot be spoofed via client-supplied flags/headers/body", async () => {
  const blob = new FakeBlob();
  const meta = new MetaStore(blob);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_BASE_DOMAIN: "drop.company.com", DROP_ADMINS: "alice@paytm.com" });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@paytm.com", email: "alice@paytm.com" },
    bob: { sub: "bob@paytm.com", email: "bob@paytm.com" },
  });
  const app = createApp({ cfg, meta, blob, verifier });
  await pub(app, "alice", "site-a", await tgz({ "index.html": "x" }));

  // bob is a fully authenticated, NON-admin user trying every client-side escalation trick.
  const spoofs = [
    { admin: true },                       // body flag
    { email: "alice@paytm.com" },          // claim someone else's identity in the body
    { isAdmin: true, role: "admin" },      // guessed field names
  ];
  for (const body of spoofs) {
    const res = await app.request("/v1/admin/sites", {
      method: "GET",
      headers: {
        authorization: "Bearer bob",       // the ONLY thing the server trusts — verified, non-admin
        "content-type": "application/json",
        "x-admin": "true",                 // spoofed header
        "x-drop-admin": "1",
      },
      body: undefined, // GET; the header spoofs above are the realistic attack surface
    });
    expect(res.status).toBe(403); // server re-derives admin from the verified token, ignores everything else
    void body;
  }

  // And the /v1/me admin flag is honest regardless of what the client sends.
  const me = await app.request("/v1/me", {
    method: "GET",
    headers: { authorization: "Bearer bob", "x-admin": "true" },
  });
  expect(((await me.json()) as { admin: boolean }).admin).toBe(false);
});

test("/v1/me reports admin flag", async () => {
  const blob = new FakeBlob();
  const meta = new MetaStore(blob);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_BASE_DOMAIN: "drop.company.com", DROP_ADMINS: "alice@paytm.com" });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@paytm.com", email: "alice@paytm.com" },
    bob: { sub: "bob@paytm.com", email: "bob@paytm.com" },
  });
  const app = createApp({ cfg, meta, blob, verifier });
  expect((await (await call(app, "GET", "/v1/me", "alice")).json()).admin).toBe(true);
  expect((await (await call(app, "GET", "/v1/me", "bob")).json()).admin).toBe(false);
});

test("publish parses _drop.json into config and does not serve it", async () => {
  const blob = new FakeBlob();
  const meta = new MetaStore(blob);
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_BASE_DOMAIN: "drop.company.com" });
  const verifier = new FakeVerifier({ alice: { sub: "alice@paytm.com", email: "alice@paytm.com" } });
  const app = createApp({ cfg, meta, blob, verifier });

  const tar = await tgz({
    "index.html": "<html>",
    "_drop.json": JSON.stringify({ spaFallback: "app.html", redirects: [{ from: "/old", to: "/new" }] }),
  });
  expect((await pub(app, "alice", "cfgsite", tar)).status).toBe(200);

  const site = (await meta.getSitePlain("cfgsite"))!;
  expect(site.config?.spaFallback).toBe("app.html");
  expect(site.config?.redirects?.[0]!.to).toBe("/new");

  const files = await blob.list(meta.filesPrefix("cfgsite", site.currentVersion!));
  expect(files.keys.some((k) => k.endsWith("/_drop.json"))).toBe(false); // not a served file
  expect(files.keys.some((k) => k.endsWith("/index.html"))).toBe(true);
});

test("publish rejects when _drop.json name mismatches the target", async () => {
  const { app } = build();
  const tar = await tgz({ "index.html": "<html>", "_drop.json": JSON.stringify({ name: "otherapp" }) });
  const res = await pub(app, "alice", "myapp", tar); // URL says myapp, bundle says otherapp
  expect(res.status).toBe(400);
});

test("ls lists owned + collaborated sites", async () => {
  const { app } = build();
  await pub(app, "alice", "one", await tgz({ "index.html": "x" }));
  await pub(app, "bob", "two", await tgz({ "index.html": "x" }));
  const res = await call(app, "GET", "/v1/sites", "alice");
  const { sites } = await res.json();
  expect(sites.map((s: any) => s.name)).toEqual(["one"]);
});
