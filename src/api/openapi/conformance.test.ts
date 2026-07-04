// L5 conformance — THE spec-can't-lie test. Each registered route is hit on the in-proc Hono app (with
// fakes) and its LIVE response is validated against the zod schema registered for it. If a handler's
// real shape drifts from its documented schema, this fails — so the generated OpenAPI spec + @drop/client
// can never silently lie about the API.

import { test, expect } from "bun:test";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { createApp } from "../server.ts";
import { apiRegistry } from "./index.ts";
import { FakeBlob } from "../../blob/fake.ts";
import { FakeKube } from "../../kube/fake.ts";
import { FakeSecretStore } from "../../secrets/fake.ts";
import { FakeImageStore } from "../../images/fake.ts";
import { FakeBucketStore } from "../../buckets/fake.ts";
import { QuotaStore } from "../../quotas/store.ts";
import { MetaStore } from "../../metastore/store.ts";
import { LockStore } from "../../metastore/lock.ts";
import { UserStore } from "../../users/store.ts";
import { OrgStore } from "../../orgs/store.ts";
import { AuditStore } from "../../audit/store.ts";
import { ServiceTokenStore } from "../../tokens/store.ts";
import { makeTestDb } from "../../db/testdb.ts";
import { FakeVerifier, ChainVerifier } from "../../auth/oidc.ts";
import { TokenVerifier } from "../../auth/token-verifier.ts";
import { loadConfig } from "../../config.ts";

async function tgz(files: Record<string, string>): Promise<Buffer> {
  const p = pack();
  for (const [n, c] of Object.entries(files)) p.entry({ name: n }, c);
  p.finalize();
  return await buffer(p.pipe(createGzip()));
}

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
  const fake = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const orgs = new OrgStore(db);
  const tokens = new ServiceTokenStore(db);
  const verifier = new ChainVerifier([new TokenVerifier(tokens, orgs), fake]);
  const images = new FakeImageStore();
  const audit = new AuditStore(db);
  const locks = new LockStore(db);
  const bucket = new FakeBucketStore();
  const quotas = new QuotaStore(db);
  return createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit, locks, bucket, quotas, tokens });
}

/** Validate a live response body against the zod schema registered for `operationId`. */
async function conform(res: Response, operationId: string) {
  expect(res.status).toBe(200);
  const json = await res.json();
  const route = apiRegistry.byOperationId(operationId);
  if (!route) throw new Error(`no registered route: ${operationId}`);
  const parsed = route.response.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${operationId} response violates its schema:\n${JSON.stringify(parsed.error.issues, null, 2)}\nbody: ${JSON.stringify(json)}`);
  }
}

const authed = (app: any, method: string, path: string, opts: { body?: any; contentType?: string } = {}) =>
  app.request(path, {
    method,
    headers: { authorization: "Bearer alice", ...(opts.contentType ? { "content-type": opts.contentType } : {}) },
    body: opts.body,
  });

test("conformance: GET /version", async () => {
  const app = await mk();
  await conform(await app.request("/version"), "getVersion");
});

test("conformance: GET /v1/me + GET /v1/features", async () => {
  const app = await mk();
  await conform(await authed(app, "GET", "/v1/me"), "getMe");
  await conform(await authed(app, "GET", "/v1/features"), "getFeatures");
});

test("conformance: POST /v1/sites/:name/versions (publish) + GET /v1/sites + GET /v1/sites/:name", async () => {
  const app = await mk();
  const body = await tgz({ "index.html": "<h1>hi</h1>" });
  await conform(await authed(app, "POST", "/v1/sites/mysite/versions", { body, contentType: "application/gzip" }), "publishSiteVersion");
  await conform(await authed(app, "GET", "/v1/sites"), "listSites");
  await conform(await authed(app, "GET", "/v1/sites/mysite"), "getSite");
});

test("conformance: GET /v1/orgs + GET /v1/orgs/:slug + GET /v1/orgs/:slug/usage", async () => {
  const app = await mk();
  // /v1/me ensures alice's personal org exists (ensureUser)
  await authed(app, "GET", "/v1/me");
  const orgsRes = await authed(app, "GET", "/v1/orgs");
  await conform(orgsRes.clone(), "listOrgs");
  const { orgs } = (await orgsRes.json()) as { orgs: { slug: string }[] };
  const slug = orgs[0]!.slug;
  await conform(await authed(app, "GET", `/v1/orgs/${encodeURIComponent(slug)}`), "getOrg");
  await conform(await authed(app, "GET", `/v1/orgs/${encodeURIComponent(slug)}/usage`), "getOrgUsage");
});

test("GET /v1/openapi.json is public + serves the assembled 3.1 spec", async () => {
  const app = await mk();
  const res = await app.request("/v1/openapi.json"); // NO auth header — must be public like /version
  expect(res.status).toBe(200);
  const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
  expect(spec.openapi).toBe("3.1.0");
  expect(Object.keys(spec.paths)).toContain("/v1/sites/{name}");
});
