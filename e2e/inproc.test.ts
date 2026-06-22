import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { FakeBlob } from "../src/blob/fake.ts";
import { FakeSecretStore } from "../src/secrets/fake.ts";
import { MetaStore } from "../src/metastore/store.ts";
import { UserStore } from "../src/users/store.ts";
import { makeTestDb } from "../src/db/testdb.ts";
import type { Db } from "../src/db/db.ts";
import { DevHeaderVerifier } from "../src/auth/oidc.ts";
import { createApp } from "../src/api/server.ts";
import { createEdge } from "../src/edge/server.ts";
import { loadConfig } from "../src/config.ts";
import { packDir } from "../src/cli/pack.ts";

// api and edge share ONE in-memory Postgres (PGlite) + blob, so the edge sees
// what the api publishes.
const blob = new FakeBlob();
const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "pglite", DROP_BASE_DOMAIN: "drop.localhost", DROP_DEV_AUTH: "1" });

let db: Db;
let api: ReturnType<typeof Bun.serve>;
let edge: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  db = await makeTestDb();
  const meta = new MetaStore(db);
  const users = new UserStore(db);
  api = Bun.serve({ port: 0, fetch: createApp({ cfg, meta, blob, db, users, verifier: new DevHeaderVerifier(), secrets: new FakeSecretStore() }).fetch });
  // pointerTtlMs: 0 so tests read the current pointer immediately (the 10s prod
  // cache is exercised separately and would otherwise mask same-test republishes).
  edge = Bun.serve({ port: 0, fetch: createEdge({ meta, blob, baseDomain: "drop.localhost", pointerTtlMs: 0 }).fetch });
});
afterAll(async () => {
  api.stop(true);
  edge.stop(true);
  await db.destroy();
});

const TOKEN = "alice:alice@example.com";

test("publish over HTTP then serve through the edge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drop-e2e-"));
  writeFileSync(join(dir, "index.html"), "<html>e2e</html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('hi')");

  const tarball = await packDir(dir);
  const pub = await fetch(`http://localhost:${api.port}/v1/sites/myapp/versions`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/gzip" },
    body: tarball,
  });
  expect(pub.status).toBe(200);
  expect(((await pub.json()) as any).url).toBe("https://myapp.drop.localhost");

  // index over the edge
  const root = await fetch(`http://localhost:${edge.port}/`, {
    headers: { host: "myapp.drop.localhost", accept: "text/html" },
  });
  expect(root.status).toBe(200);
  expect(await root.text()).toBe("<html>e2e</html>");

  // static asset
  const asset = await fetch(`http://localhost:${edge.port}/assets/app.js`, {
    headers: { host: "myapp.drop.localhost" },
  });
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toContain("javascript");

  // SPA deep-link falls back to index
  const deep = await fetch(`http://localhost:${edge.port}/dashboard`, {
    headers: { host: "myapp.drop.localhost", accept: "text/html" },
  });
  expect(deep.status).toBe(200);
  expect(await deep.text()).toBe("<html>e2e</html>");

  // missing asset → 404, not HTML
  const miss = await fetch(`http://localhost:${edge.port}/assets/missing.js`, {
    headers: { host: "myapp.drop.localhost" },
  });
  expect(miss.status).toBe(404);
});

test("rollback over HTTP serves the previous version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drop-e2e2-"));
  writeFileSync(join(dir, "index.html"), "<html>v2</html>");
  await fetch(`http://localhost:${api.port}/v1/sites/myapp/versions`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/gzip" },
    body: await packDir(dir),
  });
  // now serving v2
  let r = await fetch(`http://localhost:${edge.port}/`, { headers: { host: "myapp.drop.localhost", accept: "text/html" } });
  expect(await r.text()).toBe("<html>v2</html>");

  // rollback (edge cache TTL is 10s; create a fresh edge to read immediately)
  const rb = await fetch(`http://localhost:${api.port}/v1/sites/myapp/rollback`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(rb.status).toBe(200);
  r = await fetch(`http://localhost:${edge.port}/`, { headers: { host: "myapp.drop.localhost", accept: "text/html" } });
  expect(await r.text()).toBe("<html>e2e</html>"); // back to v1
});
