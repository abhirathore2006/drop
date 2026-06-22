# App Secrets + lifecycle controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-app, write-only secrets managed via CLI/dashboard/MCP, stored behind a pluggable
`SecretStore` (k8s local, AWS Secrets Manager prod), injected as env vars; plus app lifecycle
controls (restart/stop/start).

**Architecture:** A `SecretStore` port (like `BlobStore`/`KubeClient`) with backend chosen at
deploy time (`DROP_SECRET_BACKEND`). Values live only in the store + the pod env; the metastore
holds key names + metadata. Every backend converges on the `<app>-secret` k8s Secret that the
Deployment `envFrom`s. Secret changes apply on the next deploy or an explicit `restart`.

**Tech stack:** TypeScript/Node, Hono API, Kysely + Postgres (PGlite in tests), the existing
`KubeClient` (node:https + SSA), `bun test`. Test doubles: `FakeKube`, `FakeBlob`, new
`FakeSecretStore`. Spec: `planning/2026-06-22-app-secrets-design.md`.

**Conventions to match:** ports live in `src/<area>/types.ts` with a Fake in the same area;
`createApp(Deps)` injects dependencies; CLI commands in `src/cli/commands.ts` + `src/cli/client.ts`;
MCP tools in `src/mcp.ts`; dashboard in `src/ui/app.tsx` + `src/ui/api.ts`; migrations append to
`src/db/migrations.ts`; authz via `can(actor, action)` in `src/authz/permissions.ts`.

---

## Task 1 — `SecretStore` port + `KubeSecretStore` + `FakeSecretStore`

**Files:**
- Create: `src/secrets/types.ts`, `src/secrets/kube-store.ts`, `src/secrets/fake.ts`, `src/secrets/secrets.ts` (helpers)
- Test: `src/secrets/secrets.test.ts`, `src/secrets/fake.test.ts`

- [ ] **Step 1 — failing test for the key validator + fingerprint** (`src/secrets/secrets.test.ts`)

```ts
import { test, expect } from "bun:test";
import { validateSecretKey, fingerprint } from "./secrets.ts";

test("validateSecretKey: env-var names only", () => {
  expect(validateSecretKey("PGPASSWORD")).toBeNull();
  expect(validateSecretKey("API_KEY_2")).toBeNull();
  expect(validateSecretKey("lowercase")).not.toBeNull();
  expect(validateSecretKey("1LEADING")).not.toBeNull();
  expect(validateSecretKey("HAS-DASH")).not.toBeNull();
  expect(validateSecretKey("")).not.toBeNull();
  expect(validateSecretKey("X".repeat(257))).not.toBeNull();
});

test("fingerprint: stable, non-reversible, differs by value", () => {
  const a = fingerprint("hunter2"), b = fingerprint("hunter2"), c = fingerprint("other");
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).not.toContain("hunter2");
  expect(a.length).toBeLessThanOrEqual(16);
});
```

- [ ] **Step 2 — run it, expect FAIL** (`bun test src/secrets/secrets.test.ts` → "not defined")

- [ ] **Step 3 — implement** (`src/secrets/secrets.ts`)

```ts
import { createHash } from "node:crypto";

const KEY_RE = /^[A-Z_][A-Z0-9_]{0,255}$/; // env-var name

export function validateSecretKey(key: unknown): string | null {
  if (typeof key !== "string") return "key must be a string";
  if (!KEY_RE.test(key)) return "key must be an UPPER_SNAKE env-var name (≤256 chars)";
  return null;
}

// Short non-reversible digest for change detection in the UI (never the value).
export function fingerprint(value: string): string {
  return createHash("sha256").update("drop-secret\0" + value).digest("hex").slice(0, 12);
}
```

- [ ] **Step 4 — define the port** (`src/secrets/types.ts`)

```ts
export interface SecretScope {
  owner: string; // canonical (lowercased) owner email
  app: string;   // workload name
  namespace: string; // tenant namespace
}

// Write-only by construction: there is NO getSecret(value). listKeys returns names only.
export interface SecretStore {
  setSecret(scope: SecretScope, key: string, value: string): Promise<void>;
  deleteSecret(scope: SecretScope, key: string): Promise<void>;
  listKeys(scope: SecretScope): Promise<string[]>;
  // Ensure injection wiring exists (e.g. the ESO ExternalSecret). No-op for the kube backend
  // (the Deployment envFroms <app>-secret directly). Called at deploy.
  ensureBinding(scope: SecretScope): Promise<void>;
  // Remove all of an app's secret material (called on app delete).
  destroy(scope: SecretScope): Promise<void>;
}

export const appSecretName = (app: string) => `${app}-secret`;
```

- [ ] **Step 5 — `FakeSecretStore`** (`src/secrets/fake.ts`) + its test (`fake.test.ts`)

```ts
import type { SecretStore, SecretScope } from "./types.ts";

export class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, Map<string, string>>(); // key(ns/app) -> {KEY: value}
  readonly bindings: string[] = [];
  private k(s: SecretScope) { return `${s.namespace}/${s.app}`; }
  async setSecret(s: SecretScope, key: string, value: string) {
    (this.values.get(this.k(s)) ?? this.values.set(this.k(s), new Map()).get(this.k(s))!).set(key, value);
  }
  async deleteSecret(s: SecretScope, key: string) { this.values.get(this.k(s))?.delete(key); }
  async listKeys(s: SecretScope) { return [...(this.values.get(this.k(s))?.keys() ?? [])].sort(); }
  async ensureBinding(s: SecretScope) { this.bindings.push(this.k(s)); }
  async destroy(s: SecretScope) { this.values.delete(this.k(s)); }
}
```

- [ ] **Step 6 — `KubeSecretStore`** (`src/secrets/kube-store.ts`): writes the `<app>-secret` k8s
  Secret directly. Reuse the existing `KubeApiClient` low-level access by adding small public
  methods to it (Task 1b below) OR construct it with the kubeconfig. Implementation:
  `setSecret` → ensure-then-patch `stringData[key]`; `deleteSecret` → JSON-patch
  `remove /data/<key>` (404/missing-key safe); `listKeys` → **not** used (the API lists from the
  metastore — see Task 3), but implement via a `GET` returning `Object.keys(data)`; `ensureBinding`
  → no-op; `destroy` → delete the Secret.

```ts
// Adds patchSecretKey / removeSecretKey / deleteSecret / readSecretKeys to KubeApiClient
// (src/kube/client.ts) — strategic/JSON patches on /api/v1/namespaces/<ns>/secrets/<name>.
// KubeSecretStore delegates to those, using appSecretName(scope.app).
```

- [ ] **Step 7 — run the suite** (`bun test src/secrets`) → PASS. **tsc** clean.

- [ ] **Step 8 — commit** `feat(secrets): SecretStore port + kube/fake backends + helpers`

---

## Task 2 — metastore: key registry + runtime_state

**Files:** Modify `src/db/migrations.ts`, `src/db/schema.ts`, `src/metastore/store.ts`; Test `src/metastore/store.test.ts`

- [ ] **Step 1 — failing test**: `upsertSecretKey` then `listSecretKeys` returns metadata (no value);
  `deleteSecretKey` removes it; `setRuntimeState`/`getSitePlain` round-trips `running|stopped`.

```ts
test("secret key registry stores names + metadata, never values", async () => {
  const { meta, db } = await mk();
  await meta.upsertSecretKey("app1", "PGPASSWORD", "fp_abc", "alice@example.com");
  const ks = await meta.listSecretKeys("app1");
  expect(ks).toEqual([{ key: "PGPASSWORD", fingerprint: "fp_abc", updatedBy: "alice@example.com", updatedAt: expect.any(String) }]);
  await meta.deleteSecretKey("app1", "PGPASSWORD");
  expect(await meta.listSecretKeys("app1")).toEqual([]);
  await db.destroy();
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — migration** (append to `src/db/migrations.ts`): new migration

```ts
// 00xx_app_secrets
async up(db) {
  await db.schema.createTable("app_secret_keys")
    .addColumn("app", "text", (c) => c.notNull())
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("fingerprint", "text", (c) => c.notNull())
    .addColumn("updated_by", "text", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("app_secret_keys_pk", ["app", "key"])
    .execute();
  await db.schema.alterTable("sites")
    .addColumn("runtime_state", "text", (c) => c.notNull().defaultTo("running"))
    .execute();
}
```

- [ ] **Step 4 — schema types** (`src/db/schema.ts`): add the `app_secret_keys` table interface +
  `runtime_state` on `sites`.

- [ ] **Step 5 — store methods** (`src/metastore/store.ts`): `upsertSecretKey(app,key,fp,by)`
  (onConflict update fp/by/updated_at), `listSecretKeys(app)`, `deleteSecretKey(app,key)`,
  `setRuntimeState(app, "running"|"stopped")`; include `runtimeState` in `getSitePlain`.

- [ ] **Step 6 — run** (`bun test src/metastore`) → PASS. **tsc** clean.

- [ ] **Step 7 — commit** `feat(metastore): app secret-key registry + runtime_state`

---

## Task 3 — secrets API (write-only) + authz + `secrets` action

**Files:** Modify `src/authz/permissions.ts`, `src/api/server.ts`, `src/api/server.ts` Deps; Test `src/api/server.test.ts`

- [ ] **Step 1 — failing tests**: owner `PUT /v1/apps/myapp/secrets/API_KEY {value}` → 200 metadata
  (no value, no leak in body); `GET /v1/apps/myapp/secrets` → `[{key, fingerprint, updatedBy,
  updatedAt}]` (never a value); `DELETE` removes it; editor → 403 on all (secrets are `configure`);
  invalid key → 400; non-app type → 409. Assert `JSON.stringify(resp)` never contains the value.

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — add the `configure`-mapped `secrets` use** (reuse `configure`; no new action needed —
  gate on `can(actor,"configure")`). Add `SecretStore` to `Deps` + `createApp` destructure
  (`d.secrets`).

- [ ] **Step 4 — endpoints** (`src/api/server.ts`):

```ts
// PUT /v1/apps/:name/secrets/:key   (configure; app only)
app.put("/v1/apps/:name/secrets/:key", async (c) => {
  const { site, actor } = await resolveApp(c); // helper: 404/409/403 like db:password
  const key = c.req.param("key");
  const err = validateSecretKey(key); if (err) return c.json({ error: err }, 400);
  const { value } = await c.req.json().catch(() => ({}));
  if (typeof value !== "string" || !value) return c.json({ error: "value required" }, 400);
  const scope = { owner: site.owner, app: site.name, namespace: tenantNamespace(site.owner) };
  await d.secrets.setSecret(scope, key, value);
  const fp = fingerprint(value);
  await d.meta.upsertSecretKey(site.name, key, fp, actor.email);
  return c.json({ key, fingerprint: fp, updatedBy: actor.email, updatedAt: now().toISOString() }); // never value
});
// GET list (names+metadata) and DELETE :key analogously; list reads d.meta.listSecretKeys.
```

- [ ] **Step 5 — run** (`bun test src/api/server.test.ts -t secret`) → PASS. **tsc** clean.

- [ ] **Step 6 — commit** `feat(api): write-only app secrets endpoints (owner/admin)`

---

## Task 4 — injection: `<app>-secret` envFrom + deploy/teardown wiring

**Files:** Modify `src/kube/manifests.ts`, `src/kube/client.ts` (`applyApp`/`deleteApp`),
`src/api/server.ts` (deploy path calls `ensureBinding`); Test `src/kube/manifests.test.ts`

- [ ] **Step 1 — failing test** (`manifests.test.ts`): the Deployment `envFrom` includes
  `{ secretRef: { name: "<app>-secret" } }` **after** `<app>-env` (secret wins); present even when
  the app has no config env.

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** (`manifests.ts`): always append `{ secretRef: { name: `${ctx.name}-secret` }, optional: true }` to the container `envFrom` (optional so a not-yet-created Secret doesn't block startup); keep `<app>-env` first.

- [ ] **Step 4 — applyApp** (`client.ts`): before applying the Deployment, ensure the `<app>-secret`
  Secret exists (create empty if absent — never overwrite existing keys). `deleteApp` deletes
  `<app>-secret`. The deploy path in `server.ts` calls `await d.secrets.ensureBinding(scope)` (no-op
  for kube; creates the ESO ExternalSecret for aws).

- [ ] **Step 5 — run** (`bun test src/kube`) → PASS. **tsc** clean.

- [ ] **Step 6 — commit** `feat(kube): inject <app>-secret via envFrom (secret wins); teardown`

---

## Task 5 — lifecycle: restart / stop / start

**Files:** Modify `src/kube/types.ts` (KubeClient + AppStatus), `src/kube/client.ts`,
`src/kube/fake.ts`, `src/api/server.ts`, `src/metastore/store.ts` (runtime_state used);
Test `src/kube/*.test.ts`, `src/api/server.test.ts`

- [ ] **Step 1 — failing tests**: `restartApp` bumps the pod-template annotation; `stopApp` pins the
  HTTPScaledObject to 0 (paused) and scales the Deployment to 0; `startApp` restores; `getAppStatus`
  returns `reason: "Stopped"` when stopped. API: `POST /v1/apps/:name/{restart,stop,start}` gated at
  `deploy` (editor OK, viewer 403); `stop` sets `runtime_state=stopped`; a subsequent deploy honors
  `stopped` (stays at 0).

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — KubeClient methods** (`client.ts`):
  - `restartApp(ns,name)` → SSA-patch the Deployment pod template annotation
    `drop.dev/restartedAt=<RFC3339>` (caller passes the timestamp; `Date.now` is fine in the real
    client) → rolling restart.
  - `stopApp(ns,name)` → patch the HTTPScaledObject with `autoscaling.keda.sh/paused-replicas: "0"`
    (or set its replica bounds to 0) so KEDA won't wake it, AND scale the Deployment to 0.
  - `startApp(ns,name, scale)` → remove the pause annotation / restore bounds to the app's
    `scale.min/max`; KEDA resumes.
  - `getAppStatus` → when the HTTPScaledObject is paused/replicas pinned 0, report `reason:"Stopped"`.
  - Mirror all in `FakeKube` (record calls + a `stopped` set; `getAppStatus` returns Stopped).

- [ ] **Step 4 — API endpoints** (`server.ts`): `restart`/`stop`/`start`, `can(actor,"deploy")`,
  app-type only; `stop`/`start` also call `d.meta.setRuntimeState`; the existing deploy handler
  checks `runtime_state` and, if `stopped`, applies the workload pinned to 0 (don't silently start).

- [ ] **Step 5 — run** (`bun test src/kube src/api`) → PASS. **tsc** clean.

- [ ] **Step 6 — commit** `feat(apps): restart/stop/start lifecycle (true-offline stop)`

---

## Task 6 — surfaces: CLI + MCP + dashboard

**Files:** `src/cli/client.ts`, `src/cli/commands.ts`, `src/mcp.ts`, `src/ui/api.ts`,
`src/ui/app.tsx`, `src/ui/main.tsx`; Tests where each has them.

- [ ] **Step 1 — CLI** (`commands.ts`/`client.ts`): `drop secrets set <app> <KEY> --stdin`
  (`--from-env-file`), `drop secrets ls <app>` (table, masked), `drop secrets rm <app> <KEY>`;
  `drop restart|stop|start <app>`. Value via stdin (reuse `readStdin`), never argv.
- [ ] **Step 2 — MCP** (`mcp.ts`): tools `secret_set`, `secret_list` (names only), `secret_delete`,
  `app_restart`, `app_stop`, `app_start` — mirror the deploy/db tool pattern.
- [ ] **Step 3 — dashboard** (`app.tsx` + `api.ts`): in the app drawer add a **Secrets** panel
  (list keys masked w/ updated-at + a "pending restart" badge when fingerprint ≠ last-applied; add/
  update form; delete) and a **lifecycle** row (Restart, Stop/Start toggled by `runtime_state`).
  `api.ts`: `secretsList/secretSet/secretDelete/restart/stop/start`. Never render a value.
- [ ] **Step 4 — run** full `bun test`; `tsc` (server + ui); `node build.mjs`.
- [ ] **Step 5 — commit** `feat(cli,mcp,ui): manage secrets + lifecycle across all surfaces`

---

## Task 7 — `aws` backend (AWS Secrets Manager + ESO) + selection + docs

**Files:** Create `src/secrets/aws-store.ts`, `src/secrets/eso.ts` (ExternalSecret manifest);
Modify `src/config.ts` (`DROP_SECRET_BACKEND`, region), `src/api/*` wiring (choose store),
`examples/DATABASE_APPS.md`; Test `src/secrets/aws-store.test.ts` (manifest shape; SDK calls mocked).

- [ ] **Step 1 — failing test**: `esoExternalSecret(scope)` produces an `external-secrets.io/v1`
  `ExternalSecret` targeting `<app>-secret` with `dataFrom.find.path: drop/<owner>/<app>/`;
  `AwsSecretsManagerSecretStore.setSecret` calls `PutSecretValue` for `drop/<owner>/<app>/<KEY>`
  (SDK injected/mocked), `deleteSecret` → `DeleteSecretCommand`, `ensureBinding` applies the
  ExternalSecret via KubeClient.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the AWS store (per-key paths; SDK client injected for testability) +
  the ESO manifest builder; `config.ts` reads `DROP_SECRET_BACKEND` (default `kube`; `aws` in prod)
  + region; the API composition root picks `KubeSecretStore` or `AwsSecretsManagerSecretStore`.
- [ ] **Step 4 — docs**: extend `examples/DATABASE_APPS.md` with "store `PGPASSWORD` as a secret
  instead of plaintext env, then `drop restart`"; note prod IRSA + ESO `ClusterSecretStore` setup.
- [ ] **Step 5 — run** full `bun test`; `tsc`. **Commit** `feat(secrets): AWS Secrets Manager backend + ESO + deploy-time selection`

---

## Self-review checklist (run before handing off)

- **Spec coverage:** write-only (no value endpoint) ✓ T3; per-key store ✓ T1/T7; pluggable backend +
  deploy-time selection ✓ T1/T7; injection + secret-wins ✓ T4; manual apply ✓ (no auto-restart) +
  restart applies ✓ T5; restart/stop/start editor+ ✓ T5; true-offline stop ✓ T5; CLI/dashboard/MCP ✓
  T6; scoping `(owner,app)` ✓ T1; audit — fold into existing audit hook or note as Future #5.
- **No value ever returned:** every secrets test asserts the value is absent from responses.
- **Type consistency:** `SecretScope`, `appSecretName`, `SecretStore` names match across tasks.
- **Naming:** `<app>-secret` (injection) vs `<app>-env` (config) vs `<app>-pwset`/`<app>-app` (DB) —
  no collisions.

## Execution handoff

Two options once you approve this plan:
1. **Subagent-driven (recommended)** — a fresh subagent per task with two-stage review between tasks.
2. **Inline** — execute here with checkpoints. Each task ends green (tests + tsc) and commits.
