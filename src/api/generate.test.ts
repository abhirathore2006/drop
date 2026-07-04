// (F2) POST /v1/stacks/generate + GET /v1/features. The LLM client is INJECTED (Deps.llm), so no real
// network call is made — each test scripts `generateSpec`. Covers: off-by-default 501, the enabled happy
// path (sanitized spec returned), the sanitizer-is-applied invariant (junk / secret-looking / unknown-type
// fields stripped), the no-usable-spec 422, provider-error 502, member authz, and the never-executes
// invariant (the route makes NO cluster calls — nothing is provisioned).
import { test, expect } from "bun:test";
import { createApp } from "./server.ts";
import type { LlmClient } from "../ai/client.ts";
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

async function mk(opts: { enabled?: boolean; llm?: LlmClient } = {}) {
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
    // Enabling the feature is JUST setting DROP_LLM_URL — off by default without it.
    ...(opts.enabled ? { DROP_LLM_URL: "http://fake-llm.local/v1/chat/completions", DROP_LLM_MODEL: "test-model" } : {}),
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
  const app = createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit, locks, bucket, quotas, tokens, llm: opts.llm });
  return { app, meta, kube, db };
}

const call = (app: any, method: string, path: string, tok: string, body?: any) =>
  app.request(path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

const fakeLlm = (fn: () => Promise<unknown> | unknown): LlmClient => ({ generateSpec: async () => fn() });

test("disabled (no DROP_LLM_URL): generate -> 501, features -> llmEnabled:false", async () => {
  const { app, db } = await mk({ enabled: false });
  const res = await call(app, "POST", "/v1/stacks/generate", "alice", { prompt: "a node api with postgres" });
  expect(res.status).toBe(501);
  expect((await res.json()).error).toContain("DROP_LLM_URL");
  const feat = await call(app, "GET", "/v1/features", "alice");
  expect(feat.status).toBe(200);
  expect((await feat.json()).llmEnabled).toBe(false);
  await db.destroy();
});

test("enabled + valid JSON: returns the sanitized spec; features -> llmEnabled:true", async () => {
  const llm = fakeLlm(() => ({
    name: "shop",
    resources: {
      db: { type: "database", storage: "1Gi" },
      api: { type: "app", image: "ghcr.io/x/api:1", uses: [{ database: "db" }] },
    },
  }));
  const { app, db } = await mk({ enabled: true, llm });
  const feat = await call(app, "GET", "/v1/features", "alice");
  expect((await feat.json()).llmEnabled).toBe(true);
  const res = await call(app, "POST", "/v1/stacks/generate", "alice", { prompt: "a node api with a postgres db" });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.spec.name).toBe("shop");
  expect(Object.keys(j.spec.resources).sort()).toEqual(["api", "db"]);
  expect(j.spec.resources.api.type).toBe("app");
  expect(j.spec.resources.api.uses).toEqual([{ database: "db" }]);
  await db.destroy();
});

test("sanitizer is applied: secret-looking + unknown fields and unknown resource types are stripped", async () => {
  const llm = fakeLlm(() => ({
    name: "shop",
    // The app carries injected secret-looking fields; a bogus resource carries an unknown type.
    resources: {
      api: { type: "app", image: "ghcr.io/x/api:1", password: "hunter2", apiKey: "sk-should-not-survive", secretToken: "abc" },
      weird: { type: "quantum-computer", foo: 1 },
    },
    notes: "assumed a single web service",
  }));
  const { app, db } = await mk({ enabled: true, llm });
  const res = await call(app, "POST", "/v1/stacks/generate", "alice", { prompt: "an api" });
  expect(res.status).toBe(200);
  const j = await res.json();
  // The unknown-type resource is dropped entirely.
  expect(Object.keys(j.spec.resources)).toEqual(["api"]);
  // The secret-looking fields never survive the sanitizer.
  expect(j.spec.resources.api.password).toBeUndefined();
  expect(j.spec.resources.api.apiKey).toBeUndefined();
  expect(j.spec.resources.api.secretToken).toBeUndefined();
  expect(j.spec.resources.api.image).toBe("ghcr.io/x/api:1");
  // The model's optional note rides through.
  expect(j.notes).toContain("assumed a single web service");
  await db.destroy();
});

test("no usable spec (pure garbage): 422", async () => {
  const llm = fakeLlm(() => ({ nonsense: true, resources: 5 }));
  const { app, db } = await mk({ enabled: true, llm });
  const res = await call(app, "POST", "/v1/stacks/generate", "alice", { prompt: "??" });
  expect(res.status).toBe(422);
  await db.destroy();
});

test("provider error: 502 with a clean message (no key/body leak)", async () => {
  const llm: LlmClient = { generateSpec: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); } };
  const { app, db } = await mk({ enabled: true, llm });
  const res = await call(app, "POST", "/v1/stacks/generate", "alice", { prompt: "an api" });
  expect(res.status).toBe(502);
  const err = (await res.json()).error as string;
  expect(err).not.toContain("ECONNREFUSED");
  await db.destroy();
});

test("empty prompt -> 400", async () => {
  const { app, db } = await mk({ enabled: true, llm: fakeLlm(() => ({ name: "x", resources: {} })) });
  const res = await call(app, "POST", "/v1/stacks/generate", "alice", { prompt: "   " });
  expect(res.status).toBe(400);
  await db.destroy();
});

test("authz: any authenticated member is allowed (no org named)", async () => {
  const llm = fakeLlm(() => ({ name: "shop", resources: { web: { type: "site", dir: "./dist" } } }));
  const { app, db } = await mk({ enabled: true, llm });
  const res = await call(app, "POST", "/v1/stacks/generate", "bob", { prompt: "a static site" });
  expect(res.status).toBe(200);
  await db.destroy();
});

test("never executes: the route provisions nothing (no site rows, no stack created)", async () => {
  const llm = fakeLlm(() => ({
    name: "shop",
    resources: { db: { type: "database", storage: "1Gi" }, api: { type: "app", image: "ghcr.io/x/api:1", uses: [{ database: "db" }] } },
  }));
  const { app, meta, db } = await mk({ enabled: true, llm });
  const res = await call(app, "POST", "/v1/stacks/generate", "alice", { prompt: "api + db" });
  expect(res.status).toBe(200);
  // The generated resources materialize as <stack>-<key> site names — NONE should exist (nothing was applied).
  expect(await meta.getSitePlain("shop-api")).toBeNull();
  expect(await meta.getSitePlain("shop-db")).toBeNull();
  // And no stack row was created — the list is still empty.
  const list = await call(app, "GET", "/v1/stacks", "alice");
  expect((await list.json()).stacks).toEqual([]);
  await db.destroy();
});
