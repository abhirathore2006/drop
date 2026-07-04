// (E3) Environments — durable, named parallel instantiations of a stack spec with per-env variable
// overlays. Standalone harness (a small mirror of server.test.ts's `mk`/`call`) so this suite lives in
// its own file and never races the concurrently-edited server.test.ts. Covers: env store CRUD + resource
// mapping keyed by (env, key); env-aware reconciler naming (default `<stack>-<key>` unchanged, named
// `<stack>-<env>-<key>`); the variable overlay (env-value + typed-field ${var} substitution; missing →
// 400); promote (target re-run with the source's applied spec + pinned image, target keeps its own vars,
// audited); graph/up ?env scoping; and default-env backward-compat.
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
import { StackStore, EnvironmentStore } from "../stacks/store.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { AuditStore } from "../audit/store.ts";
import { makeTestDb } from "../db/testdb.ts";
import { FakeVerifier } from "../auth/oidc.ts";
import { loadConfig } from "../config.ts";

async function mk(env: Record<string, string> = {}) {
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
    ...env,
  });
  const verifier = new FakeVerifier({
    alice: { sub: "alice@example.com", email: "alice@example.com" },
    bob: { sub: "bob@example.com", email: "bob@example.com" },
  });
  const orgs = new OrgStore(db);
  const images = new FakeImageStore();
  const audit = new AuditStore(db);
  const locks = new LockStore(db);
  const bucket = new FakeBucketStore();
  const quotas = new QuotaStore(db);
  const app = createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit, locks, bucket, quotas });
  return { app, meta, kube, orgs, audit, db, users };
}

const call = (app: any, method: string, path: string, tok: string, body?: any) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
const json = async (r: Response) => await (r as any).json();

const baseStack = {
  name: "shop",
  resources: {
    db: { type: "database", storage: "1Gi" },
    api: { type: "app", uses: [{ database: "db" }] },
  },
};

// ---- store-level CRUD + (env, key) mapping ---------------------------------------------------------
test("E3 store: env CRUD + resource mapping keyed by (env, key); default env isolated from named", async () => {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@example.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@example.com");
  const stacks = new StackStore(db);
  const envs = new EnvironmentStore(db);
  const stack = await stacks.create({ name: "shop", orgId: org.id, spec: { name: "shop", resources: { db: { type: "database" } } }, createdBy: "alice@example.com" });

  // Same resource key in two different envs → two distinct rows (default '' + "staging").
  await stacks.setResource(stack.id, "", "db", "shop-db");
  await stacks.setResource(stack.id, "staging", "db", "shop-staging-db");
  expect(await stacks.mapping(stack.id)).toEqual({ db: "shop-db" }); // default env
  expect(await stacks.mapping(stack.id, "staging")).toEqual({ db: "shop-staging-db" });
  expect((await stacks.allResources(stack.id)).length).toBe(2);

  // env row CRUD
  const e = await envs.create({ stackId: stack.id, name: "staging", variables: { k: "v" }, createdBy: "alice@example.com" });
  expect(e.variables).toEqual({ k: "v" });
  expect((await envs.get(stack.id, "staging"))!.variables.k).toBe("v");
  expect((await envs.list(stack.id)).map((x) => x.name)).toEqual(["staging"]);

  // deleteResource is env-scoped; the default env is untouched
  await stacks.deleteResource(stack.id, "staging", "db");
  expect(await stacks.mapping(stack.id, "staging")).toEqual({});
  expect(await stacks.mapping(stack.id)).toEqual({ db: "shop-db" });

  await envs.delete(stack.id, "staging");
  expect(await envs.get(stack.id, "staging")).toBeNull();
  await db.destroy();
});

// ---- lifecycle + env-aware naming + default-env backward-compat -----------------------------------
test("E3 routes: env create/list/rm; named env materializes <stack>-<env>-<key>; default env stays <stack>-<key>", async () => {
  const { app, meta, db } = await mk();
  // bootstrap the stack (DEFAULT env) — classic <stack>-<key> names, no env rows yet (backward-compat)
  expect((await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: baseStack, resolved: { api: { image: "api:1" } } })).status).toBe(200);
  expect((await meta.getSitePlain("shop-db"))!.type).toBe("database");
  expect((await meta.getSitePlain("shop-api"))!.type).toBe("app");

  // create a named env
  expect((await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "staging", variables: {} })).status).toBe(200);
  // duplicate → 409
  expect((await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "staging" })).status).toBe(409);
  // "default" is reserved, "--" is rejected (single-dash naming)
  expect((await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "default" })).status).toBe(400);
  expect((await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "sta--ging" })).status).toBe(400);

  const list = await json(await call(app, "GET", "/v1/stacks/shop/environments", "alice"));
  expect(list.environments.map((e: any) => e.name)).toEqual(["staging"]);
  expect(list.default).toEqual({ name: "default", resources: 2 });

  // up the NAMED env → <stack>-staging-<key>; the app binds to ITS env's DB (shop-staging-db)
  const up = await call(app, "POST", "/v1/stacks/shop/up?env=staging", "alice", { spec: baseStack, resolved: { api: { image: "api:2" } } });
  expect(up.status).toBe(200);
  const upBody = await json(up);
  expect(upBody.plan.map((s: any) => [s.action, s.key, s.siteName])).toEqual([
    ["create", "db", "shop-staging-db"],
    ["create", "api", "shop-staging-api"],
  ]);
  expect((await meta.getSitePlain("shop-staging-db"))!.type).toBe("database");
  expect((await meta.getSitePlain("shop-staging-api"))!.type).toBe("app");
  // the DEFAULT env's resources are untouched (still exist under their original names)
  expect(await meta.getSitePlain("shop-db")).not.toBeNull();
  // env-list now reports staging's 2 resources
  const list2 = await json(await call(app, "GET", "/v1/stacks/shop/environments", "alice"));
  expect(list2.environments[0].resources).toBe(2);

  // a default-env re-up is an all-noop (existing stack, no env → default env; backward-compat)
  const reup = await json(await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: baseStack, resolved: { api: { image: "api:1" } }, spec_version: 1 }));
  expect(reup.plan.every((s: any) => s.action === "noop")).toBe(true);

  // rm --cascade tears down staging's resources; the default env is untouched
  expect((await call(app, "DELETE", "/v1/stacks/shop/environments/staging?cascade=1", "alice")).status).toBe(200);
  expect(await meta.getSitePlain("shop-staging-db")).toBeNull();
  expect(await meta.getSitePlain("shop-db")).not.toBeNull();
  expect((await json(await call(app, "GET", "/v1/stacks/shop/environments", "alice"))).environments.length).toBe(0);
  await db.destroy();
});

// ---- variable overlay: env-value + typed-field ${var} substitution; missing → 400 -----------------
test("E3 variable overlay: env-value + typed-field ${var} substituted; missing required → 400", async () => {
  const { app, kube, db } = await mk();
  // bootstrap a concrete default env (placeholder-free)
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: { name: "shop", resources: { api: { type: "app", image: "x:1" } } }, resolved: { api: { image: "x:1" } } });
  // env with a variable overlay (size stays under the default per-db storage cap so it isn't clamped)
  expect((await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "staging", variables: { greeting: "hello", size: "512Mi" } })).status).toBe(200);

  // up staging with placeholders in an ENV VALUE and a TYPED field (storage)
  const spec = {
    name: "shop",
    resources: {
      db: { type: "database", storage: "${var.size}" },
      api: { type: "app", image: "x:1", env: { GREETING: "${var.greeting}" }, uses: [{ database: "db" }] },
    },
  };
  const up = await call(app, "POST", "/v1/stacks/shop/up?env=staging", "alice", { spec, resolved: { api: { image: "x:1" } } });
  expect(up.status).toBe(200);
  // env-value placeholder resolved: the app's `env` lands in its `<name>-env` config Secret (SEC-5)
  const envSecret = (kube.applies.find((a) => a.name === "shop-staging-api")!.manifests as any).secret;
  expect(envSecret.stringData.GREETING).toBe("hello");
  // typed-field placeholder resolved in the DB manifest storage size (preserving-sanitize kept ${var.size},
  // then resolveEnvSpec substituted 512Mi — a default (no var) would be the 1Gi sanitizer default).
  const dbCluster = kube.dbApplies.find((a) => a.name === "shop-staging-db")!.manifests.cluster as any;
  expect(dbCluster.spec.storage.size).toBe("512Mi");

  // a referenced-but-unprovided variable is a clean 400
  const bad = await call(app, "POST", "/v1/stacks/shop/up?env=staging", "alice", {
    spec: { name: "shop", resources: { api: { type: "app", image: "x:1", env: { X: "${var.absent}" } } } },
    resolved: { api: { image: "x:1" } },
  });
  expect(bad.status).toBe(400);
  expect((await json(bad)).error).toMatch(/missing required variable/i);
  await db.destroy();
});

// ---- graph ?env= scoping ---------------------------------------------------------------------------
test("E3 graph ?env=: env-scoped node site names; default graph unchanged", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: baseStack, resolved: { api: { image: "api:1" } } });
  await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "staging", variables: {} });
  await call(app, "POST", "/v1/stacks/shop/up?env=staging", "alice", { spec: baseStack, resolved: { api: { image: "api:1" } } });

  const gDefault = await json(await call(app, "GET", "/v1/stacks/shop/graph", "alice"));
  expect(gDefault.env).toBe("");
  expect(gDefault.nodes.find((n: any) => n.key === "db").siteName).toBe("shop-db");
  expect(gDefault.nodes.every((n: any) => n.exists)).toBe(true);

  const gStaging = await json(await call(app, "GET", "/v1/stacks/shop/graph?env=staging", "alice"));
  expect(gStaging.env).toBe("staging");
  expect(gStaging.nodes.find((n: any) => n.key === "db").siteName).toBe("shop-staging-db");
  expect(gStaging.nodes.find((n: any) => n.key === "api").siteName).toBe("shop-staging-api");
  expect(gStaging.nodes.every((n: any) => n.exists)).toBe(true);

  // a not-yet-materialized env scopes names but shows nothing live
  const gProd = await json(await call(app, "GET", "/v1/stacks/shop/graph?env=prod", "alice"));
  expect(gProd.nodes.find((n: any) => n.key === "db").siteName).toBe("shop-prod-db");
  expect(gProd.nodes.every((n: any) => !n.exists)).toBe(true);
  await db.destroy();
});

// ---- promote: target re-run with source's applied spec + pinned image; target keeps its own vars ---
test("E3 promote: target re-runs with the source's applied spec (image pinned exact); target keeps its own variables; audited", async () => {
  const { app, kube, audit, db } = await mk();
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: baseStack, resolved: { api: { image: "api:default" } } });
  await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "staging", variables: {} });
  await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "prod", variables: { region: "eu" } });
  // staging runs the tested artifact api:staging; prod initially runs api:prod
  await call(app, "POST", "/v1/stacks/shop/up?env=staging", "alice", { spec: baseStack, resolved: { api: { image: "api:staging" } } });
  await call(app, "POST", "/v1/stacks/shop/up?env=prod", "alice", { spec: baseStack, resolved: { api: { image: "api:prod" } } });
  const prodImageBefore = (kube.applies.filter((a) => a.name === "shop-prod-api").at(-1)!.manifests.deployment as any).spec.template.spec.containers[0].image;
  expect(prodImageBefore).toBe("api:prod");

  // promote staging → prod: prod re-reconciles with staging's CURRENTLY-APPLIED image (exact pinned ref)
  const promo = await call(app, "POST", "/v1/stacks/shop/environments/staging/promote", "alice", { to: "prod" });
  expect(promo.status).toBe(200);
  const promoBody = await json(promo);
  expect(promoBody.from).toBe("staging");
  expect(promoBody.to).toBe("prod");
  const prodImageAfter = (kube.applies.filter((a) => a.name === "shop-prod-api").at(-1)!.manifests.deployment as any).spec.template.spec.containers[0].image;
  expect(prodImageAfter).toBe("api:staging"); // exact artifact promotion — not a rebuild

  // the target env KEEPS its own variables (promote is NOT a variable copy)
  const envs = await json(await call(app, "GET", "/v1/stacks/shop/environments", "alice"));
  expect(envs.environments.find((e: any) => e.name === "prod").variables).toEqual({ region: "eu" });

  // audited env.promote (asserted via the audit store — no platform-admin route needed)
  const trail = await audit.list({ action: "env.promote" });
  expect(trail.entries.length).toBe(1);
  expect(trail.entries[0]!.detail).toMatchObject({ from: "staging", to: "prod" });
  await db.destroy();
});

// ---- authz + not-found edges ----------------------------------------------------------------------
test("E3 authz: env create/promote need create-rights; delete is owner/admin; unknown env → 404", async () => {
  const { app, db } = await mk();
  await call(app, "POST", "/v1/stacks/shop/up", "alice", { spec: baseStack, resolved: { api: { image: "api:1" } } });
  // a viewer collaborator cannot create/delete envs
  await call(app, "POST", "/v1/sites/shop-api/collaborators", "alice", { email: "bob@example.com", role: "viewer" });
  // bob isn't a member of alice's personal org at all → create env 404s (no such stack, via findStack) or 403
  const bobCreate = await call(app, "POST", "/v1/stacks/shop/environments", "bob", { env: "x" });
  expect([403, 404]).toContain(bobCreate.status);

  // up of an unknown env → 404
  expect((await call(app, "POST", "/v1/stacks/shop/up?env=ghost", "alice", { spec: baseStack, resolved: { api: { image: "api:1" } } })).status).toBe(404);
  // promote to a non-existent target → 404
  await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "staging" });
  expect((await call(app, "POST", "/v1/stacks/shop/environments/staging/promote", "alice", { to: "ghost" })).status).toBe(404);
  // promote source === target → 400
  await call(app, "POST", "/v1/stacks/shop/environments", "alice", { env: "prod" });
  expect((await call(app, "POST", "/v1/stacks/shop/environments/staging/promote", "alice", { to: "staging" })).status).toBe(400);
  await db.destroy();
});
