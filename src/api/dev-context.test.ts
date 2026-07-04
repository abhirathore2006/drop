// (L3) GET /v1/apps/:name/dev-context — the NON-secret surface `drop dev` composes an env from.
// Asserts: deploy-tier authz; NON-secret env passthrough; DB/cache binding metadata shape; secret KEY
// NAMES present with NO values; and the secrets-never-pulled invariant (no secret VALUE in the body).
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
import { ServiceTokenStore } from "../tokens/store.ts";
import { makeTestDb } from "../db/testdb.ts";
import { FakeVerifier, ChainVerifier } from "../auth/oidc.ts";
import { TokenVerifier } from "../auth/token-verifier.ts";
import { loadConfig } from "../config.ts";

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
  const fake = new FakeVerifier({
    alice: { sub: "alice@example.com", email: "alice@example.com" },
    bob: { sub: "bob@example.com", email: "bob@example.com" },
  });
  const orgs = new OrgStore(db);
  const tokens = new ServiceTokenStore(db);
  const verifier = new ChainVerifier([new TokenVerifier(tokens, orgs), fake]);
  const images = new FakeImageStore();
  const audit = new AuditStore(db);
  const locks = new LockStore(db);
  const bucket = new FakeBucketStore();
  const quotas = new QuotaStore(db);
  const app = createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit, locks, bucket, quotas, tokens });
  return { app, meta, db };
}

const call = (app: any, method: string, path: string, tok: string, body?: any) =>
  app.request(path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

/** Stand up an org + DB + cache + an app that binds both, has non-secret env, a web command, and two
 *  write-only secrets. Returns the app's namespace for host assertions. */
async function seedApp(app: any): Promise<string> {
  expect((await call(app, "POST", "/v1/orgs", "alice", { slug: "acme", name: "Acme" })).status).toBe(200);
  expect((await call(app, "POST", "/v1/databases/billdb?org=acme", "alice", {})).status).toBe(200);
  expect((await call(app, "POST", "/v1/caches/sessions?org=acme", "alice", {})).status).toBe(200);
  const dep = await call(app, "POST", "/v1/apps/billing?org=acme", "alice", {
    image: "billing:1",
    env: { NODE_ENV: "production", LOG_LEVEL: "info" }, // NON-secret env (the <billing>-env source)
    uses: [{ database: "billdb" }, { cache: "sessions" }],
    processes: { web: { command: ["node", "server.js"] } },
  });
  expect(dep.status).toBe(200);
  // two write-only secrets — dev-context must surface their NAMES only.
  expect((await call(app, "PUT", "/v1/apps/billing/secrets/STRIPE_KEY", "alice", { value: "hi9Ent2RopyVal6ueXz8Qk" })).status).toBe(200);
  expect((await call(app, "PUT", "/v1/apps/billing/secrets/JWT_SECRET", "alice", { value: "super_secret_jwt_value" })).status).toBe(200);
  return "drop-acme"; // org namespace convention
}

test("dev-context: returns non-secret env, DB/cache binding metadata, secret KEY NAMES + web command", async () => {
  const { app, db } = await mk();
  await seedApp(app);
  const res = await call(app, "GET", "/v1/apps/billing/dev-context", "alice");
  expect(res.status).toBe(200);
  const j = await res.json();

  expect(j.app).toBe("billing");
  // NON-secret env passthrough (the app.env we deployed) — and nothing else.
  expect(j.env).toEqual({ NODE_ENV: "production", LOG_LEVEL: "info" });
  // the L1 web-process command drop dev defaults to.
  expect(j.command).toEqual(["node", "server.js"]);

  // binding metadata — a DB (tunnelable) + a cache (not tunneled here).
  const dbB = j.bindings.find((b: any) => b.kind === "database");
  expect(dbB).toMatchObject({
    resource: "billdb",
    host: `billdb-rw.${j.namespace}.svc.cluster.local`,
    port: 5432,
    hostVar: "PGHOST",
    portVar: "PGPORT",
    tunnelTicketPath: "/v1/databases/billdb/tunnel-ticket",
  });
  const cacheB = j.bindings.find((b: any) => b.kind === "cache");
  expect(cacheB).toMatchObject({
    resource: "sessions",
    host: `sessions.${j.namespace}.svc.cluster.local`,
    port: 6379,
    urlVar: "REDIS_URL",
    tunnelTicketPath: null,
  });

  // secret KEY NAMES only — the two we set, plus REDIS_URL injected by the cache binding.
  expect(j.secretKeys).toContain("STRIPE_KEY");
  expect(j.secretKeys).toContain("JWT_SECRET");
  expect(j.secretKeys).toContain("REDIS_URL");
  await db.destroy();
});

test("dev-context: the secrets-never-pulled invariant — NO secret VALUE appears in the response", async () => {
  const { app, db } = await mk();
  await seedApp(app);
  const res = await call(app, "GET", "/v1/apps/billing/dev-context", "alice");
  const bodyText = await res.text();
  // the secret VALUES we wrote must never cross this endpoint (names only)...
  expect(bodyText).not.toContain("hi9Ent2RopyVal6ueXz8Qk");
  expect(bodyText).not.toContain("super_secret_jwt_value");
  // ...and neither must the cache password embedded in the REDIS_URL the binding injected.
  expect(bodyText).not.toContain("redis://:"); // the URL value (with password) is never returned
  await db.destroy();
});

test("dev-context: authz is deploy-tier — a non-member is 403, unknown 404, a non-app 409", async () => {
  const { app, db } = await mk();
  await seedApp(app);
  // bob is not a member of acme → no deploy → 403
  expect((await call(app, "GET", "/v1/apps/billing/dev-context", "bob")).status).toBe(403);
  // unknown app → 404
  expect((await call(app, "GET", "/v1/apps/ghost/dev-context", "alice")).status).toBe(404);
  // a database name (non-app) → 409 (resolveApp)
  expect((await call(app, "GET", "/v1/apps/billdb/dev-context", "alice")).status).toBe(409);
  await db.destroy();
});

test("dev-context: an org MEMBER (deploy-tier) can read it", async () => {
  const { app, db } = await mk();
  await seedApp(app);
  expect((await call(app, "POST", "/v1/orgs/acme/members", "alice", { email: "bob@example.com", role: "member" })).status).toBe(200);
  expect((await call(app, "GET", "/v1/apps/billing/dev-context", "bob")).status).toBe(200);
  await db.destroy();
});
