# App Secrets + lifecycle controls — design spec

**Status:** proposed (awaiting review) · **Date:** 2026-06-22

**Goal.** Give every Drop app a first-class way to manage **secrets** (DB passwords, API keys,
tokens) that are managed via **CLI, dashboard, and MCP**, **stored in a pluggable secret manager**
scoped to `(user, app)`, **write-only** (set/rotate/delete but never readable once saved), and
**injected as environment variables**. Secret changes apply via an explicit **restart**, and the
dashboard gains **restart / stop / start** controls for apps.

**Non-goal.** Not a replacement for non-secret config (`app.env` in `drop.yaml`), and not the
DB-credential path (that is first-class DB binding, `Future.md` #1); both compose via `envFrom`.

---

## 1. Principle: config vs. secrets

| | **Config** (today) | **Secret** (this spec) |
|---|---|---|
| Examples | `PGHOST`, `PGPORT`, `LOG_LEVEL` | `PGPASSWORD`, API keys, tokens |
| Declared in | `drop.yaml` `app.env` (committed, viewable) | **never** in `drop.yaml`/git — managed out-of-band |
| k8s object | `<app>-env` Secret | **separate** `<app>-secret` Secret |
| Readable back? | yes | **no — write-only** |
| Injection | `envFrom: secretRef <app>-env` | `envFrom: secretRef <app>-secret` |

On a key collision the **secret wins** (`<app>-secret` is listed last in `envFrom`); documented.

---

## 2. The write-only contract

The platform stores **values only in the secret store**; the metastore stores **only metadata**
(key names, who/when, a non-reversible fingerprint). API surface (per app):

- `PUT /v1/apps/:name/secrets/:key {value}` — set/overwrite (create-or-rotate). Returns metadata
  `{ key, updatedAt, updatedBy, fingerprint }` — **never the value**.
- `GET /v1/apps/:name/secrets` — list **key names + metadata** only. Never values.
- `DELETE /v1/apps/:name/secrets/:key` — remove.

There is **deliberately no endpoint that returns a value.** Once saved, a secret can only be
overwritten or deleted — never read back (GitHub-Actions style; stricter than Heroku). A value
never appears in any API response, log, the metastore, or MCP output — only in the secret store and
the running pod's env. (A platform admin with raw cluster/manager access could read the underlying
object — an auditable break-glass, not a product surface.)

`fingerprint` = a short non-reversible digest (e.g. first 8 hex of `sha256(salt‖value)`) so the UI
can show "changed" without revealing anything.

---

## 3. Storage: one protocol, pluggable backends (chosen at deploy time)

A `SecretStore` **port** — the protocol — mirroring how `BlobStore`/`KubeClient` abstract
local-vs-prod. Backend selected at deploy time via `DROP_SECRET_BACKEND`; **AWS Secrets Manager is
the prod default**, k8s Secrets is local/fallback, `gcp`/`azure`/`vault` plug in behind the same
interface.

```ts
type SecretScope = { owner: string; app: string; namespace: string };

interface SecretStore {
  setSecret(scope: SecretScope, key: string, value: string): Promise<void>;
  deleteSecret(scope: SecretScope, key: string): Promise<void>;
  listKeys(scope: SecretScope): Promise<string[]>; // names only — there is NO getSecret(value)
  ensureBinding(scope: SecretScope): Promise<void>; // ensure injection wiring (e.g. ESO ExternalSecret); no-op for kube
}
```

**Per-key layout (decided): each secret is its own object** — no JSON blob, no read-modify-write,
so `set`/`delete` touch only that one key (strict write-only; the platform never reads sibling
values).

- **`kube` (default local; valid prod with KMS):** the value is a key in the `<app>-secret` k8s
  Secret in the tenant namespace — `set` = patch `stringData[key]`, `delete` = JSON-patch
  `remove /data/<key>`. Enable an etcd KMS provider in prod. Zero new infra.
- **`aws` (default prod):** one **AWS Secrets Manager** secret **per key** at
  `drop/<owner-slug>/<app>/<KEY>` — `set` = `PutSecretValue`, `delete` = `DeleteSecret` (no merge).
  **External Secrets Operator** runs one per-app `ExternalSecret` using `dataFrom.find.path:
  drop/<owner>/<app>/`, which dynamically pulls every key under the path into the `<app>-secret`
  k8s Secret → the pod. Per-tenant IAM via IRSA (same posture as CNPG backups). This is the literal
  "secret manager scoped to `/user/app`", and `find.path` means adding/removing a key needs no
  ExternalSecret edit.
- **`gcp` / `azure` / `vault`:** identical shape — per-key write to the provider at
  `drop/<user>/<app>/<KEY>`, inject via ESO (which already adapts all of these). Adding one is a new
  `SecretStore` write impl + ESO provider config — **no change to the app/Deployment side**.

**Cloud-portable by construction:** every backend converges on the same `<app>-secret` k8s Secret
the Deployment `envFrom`s. The app never knows the backend; switching clouds is deploy-time config
(+ ESO provider wiring), not app or core-platform change. `listKeys` reads the metastore registry
(below), never the backend — keeping the store strictly on the write path.

---

## 4. Injection + apply timing (manual)

- `appManifests` `envFrom`s **both** `<app>-env` (config) and `<app>-secret` (secrets); every secret
  key becomes an env var.
- **Manual apply (no auto-restart):** `set`/`delete` update the store immediately but do **not**
  restart the app — running pods keep their current env until the next **deploy** or an explicit
  **restart** (§5). This avoids surprise rollouts of a live app. The Secrets UI shows a "changed
  since last start — restart to apply" hint (via the fingerprint vs. a recorded last-applied hash).

---

## 5. App lifecycle controls (restart / stop / start)

Operational controls on a deployed **app** (type `app`; databases use hibernation, `Future.md` #3).
Exposed in the dashboard, plus API + CLI/MCP for parity. The metastore tracks a per-app
`runtime_state` (`running` | `stopped`) so a stop survives reconciliation/redeploy.

- **restart** — `POST /v1/apps/:name/restart`: bump pod-template annotation
  `drop.dev/restartedAt=<ts>` → rolling restart; new pods re-read `<app>-secret` + `<app>-env`.
  **This is how a changed secret is applied.**
- **stop** — `POST /v1/apps/:name/stop`: take the app offline — pin the workload to 0 and prevent
  KEDA from waking it on traffic (pause the HTTPScaledObject / `paused-replicas: "0"`), set
  `runtime_state=stopped`. A redeploy honors `stopped` (doesn't silently restart).
- **start** — `POST /v1/apps/:name/start`: restore the configured `scale.min/max`, clear `stopped`.

The status read-model (`getAppStatus`) surfaces `Stopped` so the dashboard renders state correctly.
**Authz:** gated at `deploy` (editor+) — operational, consistent with who can ship a revision.
*(Open: prefer owner-only? — see §11.)*

---

## 6. Data model (metastore)

- New table `app_secret_keys` — registry of key names + metadata, **never values**:
  `app` (FK), `key` (`^[A-Z_][A-Z0-9_]*$`), `fingerprint`, `updated_by`, `updated_at`; PK `(app,key)`.
  Powers `listKeys`, the dashboard, and the "changed/pending" hint without touching the backend.
- Add `runtime_state` (`running`|`stopped`, default `running`) + optional `last_secrets_applied_hash`
  to the app's site row. Deleting an app cascades (and tears down the backend objects + ESO
  ExternalSecret).

---

## 7. Surfaces

- **CLI:**
  - `drop secrets set <app> <KEY> --stdin` (value from stdin/prompt — **never argv**) ·
    `--from-env-file .env` for bulk · `drop secrets ls <app>` (keys + metadata, masked `••••`) ·
    `drop secrets rm <app> <KEY>`.
  - `drop restart <app>` · `drop stop <app>` · `drop start <app>`.
- **Dashboard (app drawer):**
  - a **Secrets** panel — list keys (masked, last-updated, "pending restart" badge), add/update form
    (key + value, write-only), delete; never renders a value.
  - a **lifecycle** control row — **Restart**, and **Stop**/**Start** (toggled by `runtime_state`).
- **MCP:** `secret_set` / `secret_list` (names only) / `secret_delete`, and `app_restart` /
  `app_stop` / `app_start`, scoped to apps the caller is authorized on.

---

## 8. Scoping & authz

- **Scope** `(owner, app)` → `<app>-secret` in `drop-t-<owner>` (kube) / provider path
  `drop/<owner>/<app>/<KEY>` (aws/gcp/azure/vault).
- **Secrets:** gated at `configure` = **owner + admin** (like set-visibility / `db:password`).
- **Lifecycle (restart/stop/start):** gated at `deploy` = **editor+** (operational). *(See §11.)*

---

## 9. Security guarantees & threat model

- Values never in: `drop.yaml`/git, API responses, logs, the metastore, MCP output — only the secret
  store + the pod env.
- **Write-only:** no read-back path; rotation = overwrite; per-key writes never touch siblings.
- **Audit:** every secret set/delete and lifecycle action writes an audit row (who/when/key/action —
  not value), feeding the audit log (`Future.md` #5).
- **Pod-log leakage** (an app printing its own env) is the residual risk — mitigated by `/logs`
  being gated at editor+ (already shipped); document "don't log secrets".
- **At rest:** `aws`/external = the manager's encryption + IAM; `kube` = etcd with a KMS provider in
  prod; namespace `get secret` restricted by RBAC.

---

## 10. Relationship to existing pieces

- **DB password:** prefer first-class DB binding (`Future.md` #1) — `envFrom: secretRef <db>-app`,
  no copy. This feature is for *arbitrary* secrets; both inject via `envFrom`. (Interim: you can
  `drop secrets set myapp PGPASSWORD …` then `drop restart myapp`.)
- **`app.env`:** unchanged, for non-secret config. Secret wins on key collision.

---

## 11. Resolved decisions

- Per-key layout (no JSON blob); secret wins on collision; manual restart (no auto-rollout);
  dashboard restart/stop/start.
- **Lifecycle authz:** `deploy` (editor+) — operational, consistent with who ships a revision.
  Secrets remain `configure` (owner/admin).
- **Stop semantics:** **true offline** — pin the workload to 0 *and* prevent KEDA from waking it on
  traffic; `start` restores the configured scale.

---

## 12. Suggested build order (for the plan)

1. `SecretStore` port + `KubeSecretStore` + `FakeSecretStore`; `app_secret_keys` migration +
   `runtime_state` column; fingerprint helper.
2. Secrets API: the three write-only endpoints + `configure` authz + audit rows.
3. Injection: `appManifests` second `envFrom` (`<app>-secret`, listed last); teardown on delete.
4. Lifecycle API: `restart` / `stop` / `start` (+ KEDA pause/restore, `runtime_state`, status
   read-model surfacing `Stopped`) + `deploy` authz.
5. Surfaces: CLI (`secrets *`, `restart`/`stop`/`start`), MCP tools, dashboard Secrets panel +
   lifecycle controls.
6. `aws` backend: `AwsSecretsManagerSecretStore` (per-key) + ESO `ExternalSecret` (`find.path`) +
   `DROP_SECRET_BACKEND` selection + prod IAM/IRSA notes.
7. Docs: extend `examples/DATABASE_APPS.md` ("use a secret instead of a plaintext `PGPASSWORD`").
