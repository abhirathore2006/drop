# Connecting a Drop app to a managed database

Runnable examples across several stacks, plus a step-by-step walkthrough of the whole flow:
**create a managed Postgres → map its connection into your app's environment → build → deploy → verify**.

| Example | Stack | What it shows |
|---|---|---|
| [`guestbook-node/`](./guestbook-node) | Node.js (no framework) + [`pg`](https://node-postgres.com) + server-rendered HTML | the minimal Node → Postgres path |
| [`tasks-node-ts/`](./tasks-node-ts) | Node.js + **TypeScript** (run via `tsx`, no framework) + `pg` | a typed `node:http` server — list/add/toggle/delete |
| [`blog-express/`](./blog-express) | **Express 5 + EJS templates** + `pg` | classic server-rendered MVC, multiple views + full CRUD |
| [`notes-next/`](./notes-next) | **Next.js** (App Router, server actions) + `pg`, standalone output | a real framework app → Postgres, list + detail/edit pages |
| [`board-tanstack/`](./board-tanstack) | **TanStack Start** (file-based routes, `createServerFn`) + `pg` | a modern full-stack React app → Postgres |

All read the **standard libpq `PG*` environment variables** and tolerate the DB still coming
up (a startup retry loop). They're intentionally tiny so the *binding* is the star — same five
env vars, same write-only `PGPASSWORD` secret, regardless of framework.

---

## How the binding works (the mental model)

When you run `drop db:create <db>`, the platform provisions a CloudNativePG cluster in **your
tenant namespace** and gives you a connection reference:

- **host** `…-rw.<namespace>.svc.cluster.local` — or just **`<db>-rw`** from another pod in the
  same namespace (your app lives there too)
- **port** `5432`  ·  **database** `app`  ·  **user** `app`
- **password** — lives in the Kubernetes Secret `<db>-app`; never printed by `db:create`

Your app reads those five values as environment variables. They split into two kinds:

- **Non-secret config** → `app.env` in `drop.yaml` (committed): `PGHOST=<db>-rw`, `PGPORT=5432`,
  `PGUSER=app`, `PGDATABASE=app`, `PGSSLMODE=require`.
- **The password** → a **write-only secret**, *never* in `drop.yaml`/git. You set it out-of-band
  with `drop secrets set <app> PGPASSWORD --stdin`; Drop stores it in the secret manager and
  injects it into the pod as an env var. It can be rotated or deleted, but never read back.

To get a password to store, use **`drop db:password <db>`** — it sets (rotates) the `app` password
and prints it **once**; pipe that into `drop secrets set`.

> Secrets are injected via a second `envFrom` (the `<app>-secret` Secret), alongside the
> `<app>-env` config. On a key collision the secret wins. See [Secrets](#secrets) below.

---

## Prerequisites

```bash
# 1. the local compute stack is up (k3s-on-podman + KEDA + CloudNativePG)
make compute-up                 # or: bash .run/cluster-up.sh, then `make floci postgres`

# 2. you're logged in to the API (dev-login needs DROP_DEV_AUTH=1 on the server)
drop dev-login me you@example.com     # local dev token; or `drop login` for Google OAuth

# 3. (optional, for a clean https:// padlock in the browser)
make trust-cert
```

These examples assume the **local k3s dev stack**, where you build images with podman and import
them into k3s's containerd. In a real cluster you'd `docker push` to a registry instead.

---

## Walkthrough — the Node guestbook

### Step 1 — create the database

```bash
drop db:create guestbook-db
```

```
  ▸ creating database guestbook-db…
  ✓ postgres-18 ready
     host: guestbook-db-rw.drop-t-…svc.cluster.local:5432  db: app  user: app
     credentials: read Secret 'guestbook-db-app' (keys username/password) … the password is never printed.
```

Note the **host**, **db** (`app`), and **user** (`app`).

### Step 2 — the env config (already in `drop.yaml`)

Open [`guestbook-node/drop.yaml`](./guestbook-node/drop.yaml). The **non-secret** connection
config is already mapped; the password is set separately as a secret (Step 5):

```yaml
app:
  name: guestbook
  image: guestbook-node:1
  services:
    - internal_port: 8080
  env:
    PGHOST: guestbook-db-rw      # the DB's -rw Service (same namespace → short name resolves)
    PGPORT: "5432"
    PGUSER: app
    PGDATABASE: app
    PGSSLMODE: require           # encrypt in transit; the app does not verify CNPG's self-signed cert
  # PGPASSWORD is NOT here — it's a write-only secret (Step 5). Never put it in drop.yaml/git.
```

> `PGHOST` is `guestbook-db-rw`, not the full FQDN, because the app pod runs in the **same tenant
> namespace** as the database. The full FQDN from `db:create` also works.

### Step 3 — build the image and import it into k3s

`drop deploy` references an image; it doesn't build one. On the local stack, build with podman and
import into k3s's containerd (k3s runs as the podman container named `k3s`):

```bash
# build (use the docker.io/library/ prefix so k8s and containerd agree on the name)
podman build -t docker.io/library/guestbook-node:1 examples/guestbook-node

# import into k3s's containerd (namespace k8s.io)
podman save docker.io/library/guestbook-node:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -
```

The `drop.yaml` `image: guestbook-node:1` resolves to `docker.io/library/guestbook-node:1`, which
now exists in containerd. Because the tag isn't `:latest`, k8s uses the local image (pull policy
`IfNotPresent`) instead of reaching for a registry.

### Step 4 — deploy

```bash
drop deploy examples/guestbook-node
```

```
  ▸ deploying guestbook  (guestbook-node:1)…
  ✓ live at https://guestbook.drop.localhost
```

### Step 5 — set the DB password as a write-only secret, then restart

```bash
drop db:password guestbook-db                                # prints the password ONCE
printf '<that password>' | drop secrets set guestbook PGPASSWORD --stdin
drop restart guestbook                                       # restart to inject the new secret
```

`drop secrets set` stores the value in the secret manager and never prints it back. `drop secrets ls
guestbook` shows the key + when it changed (never the value). The app picks up a new/changed secret
on the next **restart** (or deploy) — that's why Step 5 ends with `drop restart`.

### Step 6 — verify

```bash
# https (after `make trust-cert`); or plain http straight to the edge on :8474
open https://guestbook.drop.localhost/        # macOS; or just paste into a browser
curl -k https://guestbook.drop.localhost/ | head
```

Sign the guestbook in the browser, then prove it persisted in Postgres:

```bash
# find your tenant namespace
NS=$(kubectl get ns --no-headers -o custom-columns=N:.metadata.name | grep '^drop-t-' | head -1)

# app logs — also in the console (https://api.drop.localhost/ → open "guestbook" → logs)
kubectl logs -n "$NS" -l app.kubernetes.io/name=guestbook --tail=20

# query the database directly through its primary pod
kubectl exec guestbook-db-1 -c postgres -n "$NS" -- psql -U app -d app -c "SELECT name, message FROM entries ORDER BY id DESC;"
```

That's the whole loop: **DB → env → image → deploy → data persists.**

---

## The Next.js notes app

Identical flow with a different DB name and a heavier build. Differences from the Node app:

- The image is a **multi-stage Next.js standalone** build, so `podman build` runs `next build`
  (slower) and produces a small self-contained runtime image.
- The image bakes `PORT=8080` and **`HOSTNAME=0.0.0.0`** (Next's standalone server binds to
  `HOSTNAME`; without `0.0.0.0` it would only listen on localhost inside the pod).

```bash
drop db:create notes-db

podman build -t docker.io/library/notes-next:1 examples/notes-next
podman save docker.io/library/notes-next:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -

drop deploy examples/notes-next                 # → https://notes.drop.localhost

drop db:password notes-db                        # prints the password ONCE
printf '<that password>' | drop secrets set notes PGPASSWORD --stdin
drop restart notes                               # apply it
```

---

## Secrets

App secrets (DB passwords, API keys, tokens) are **write-only** and injected as env vars — never
in `drop.yaml`/git, never readable back.

```bash
printf 'value' | drop secrets set <app> SOME_KEY --stdin   # set/rotate (stdin keeps it out of shell history)
drop secrets ls <app>                                      # key names + when changed (NEVER the value)
drop secrets rm <app> SOME_KEY                              # delete
drop restart <app>                                         # secrets apply on the next restart/deploy
```

Where the value lives depends on the backend, chosen at deploy time (`DROP_SECRET_BACKEND`): the
default `kube` writes the `<app>-secret` Kubernetes Secret directly; `aws` stores it in **AWS
Secrets Manager** at `drop/<namespace>/<app>/<KEY>` and the External Secrets Operator syncs it into
the `<app>-secret` Secret. Locally, `aws` runs against **Floci's** Secrets-Manager emulation, so the
local stack exercises the same path as prod. Either way the app just sees env vars. Manage secrets
from the **console** (app drawer → Secrets) or the `secret_set`/`secret_list`/`secret_delete` **MCP**
tools too. Owner/admin only.

## Rotating the password later

`drop db:password <db>` rotates the live `app` role password and returns the new one once; store it
as the secret and restart:

```bash
drop db:password guestbook-db
printf '<new password>' | drop secrets set guestbook PGPASSWORD --stdin
drop restart guestbook
```

## Lifecycle: restart / stop / start

```bash
drop restart <app>   # roll the pods (applies new secrets/config)
drop stop <app>      # true offline — scale to 0 AND won't wake on traffic
drop start <app>     # bring it back (restores the configured scale)
```

Also in the console (app drawer → lifecycle row) and via the `app_restart`/`app_stop`/`app_start`
MCP tools. Editor+ (operational).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ErrImagePull` / `ImagePullBackOff` | Image not imported, name mismatch, or a `:latest` tag (forces a pull). Rebuild + re-import with the `docker.io/library/<name>:<tag>` ref, keep the tag non-`latest`. |
| `connection refused` / `timeout` to the DB | Wrong `PGHOST` (must be `<db>-rw`), or the DB isn't Ready yet (`kubectl get cluster -A`). The apps retry for ~60s on startup. |
| `password authentication failed` | The `PGPASSWORD` secret doesn't match the live role — re-run `drop db:password <db>`, `drop secrets set <app> PGPASSWORD --stdin`, then `drop restart <app>`. A secret change needs a restart to take effect. |
| TLS / `self-signed certificate` errors | CNPG uses a self-signed cert. The samples set `ssl.rejectUnauthorized:false`; if you wrote your own client, do the same (or mount the `<db>-ca` Secret and verify). `PGSSLMODE=disable` turns TLS off. |
| Next.js app starts but isn't reachable | The image must set `HOSTNAME=0.0.0.0` (already in its Dockerfile); the standalone server otherwise binds localhost only. |
| App responds 502 / never wakes | `internal_port` in `drop.yaml` must match the port the app listens on (8080 here). |
| `npm install` fails with a cert error during `podman build` | You're behind a TLS-inspecting proxy (e.g. Zscaler). Easiest fix: install/build on the host where `NODE_EXTRA_CA_CERTS` is set, then change the Dockerfile to `COPY` the prebuilt `node_modules`/`.next/standalone` instead of running `npm install`. Or bake your corp CA into the build and set `NODE_EXTRA_CA_CERTS` before `npm install`. |

### Useful checks

```bash
kubectl get pods -A | grep drop-t-                       # app + DB pods
kubectl get cluster -A                                   # CNPG database health
drop info guestbook                                      # workload metadata + status
```

---

## Environment variables reference

| Var | Value | Notes |
|---|---|---|
| `PGHOST` | `<db>-rw` | the DB's read-write Service (primary), same namespace |
| `PGPORT` | `5432` | |
| `PGUSER` | `app` | CNPG's application role |
| `PGDATABASE` | `app` | CNPG's application database |
| `PGPASSWORD` | from `drop db:password <db>` | a **secret** — set write-only via `drop secrets set <app> PGPASSWORD --stdin`, never in `drop.yaml`/git |
| `PGSSLMODE` | `require` | the samples encrypt without verifying the self-signed cert; `disable` turns TLS off |
