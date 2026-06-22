# board — TanStack Start + managed Postgres

A Postgres-backed link board: a Drop **container app** (`drop deploy`), not a static site.
[TanStack Start](https://tanstack.com/start) (file-based routes + `createServerFn` server
functions) + [`pg`](https://node-postgres.com), server-rendered, full CRUD. Reads the standard
libpq `PG*` env vars.

Pages: **list** (`/`, with an inline add form + per-item delete), **detail** (`/items/:id`),
**edit** (`/items/:id/edit`). Table: `items(id, title, url, created_at)`.

## Deploy (local k3s dev stack)

**Prereqs:** the compute stack is up (`make compute-up`) and you're logged in
(`drop dev-login me you@example.com`, or `drop login`).

```bash
# 1. create the managed Postgres database
drop db:create board-db

# 2. build the image and import it into k3s (k3s runs as the podman container `k3s`)
#    `vite build` runs inside the build — it generates the route tree + the .output node server.
podman build -t docker.io/library/board-tanstack:1 examples/board-tanstack
podman save docker.io/library/board-tanstack:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -

# 3. deploy (reads this folder's drop.yaml — the non-secret PG* config is already there)
drop deploy examples/board-tanstack

# 4. set the DB password as a write-only SECRET (never committed), then apply it
drop db:password board-db                                 # prints the password ONCE
printf '<that password>' | drop secrets set board PGPASSWORD --stdin
drop restart board                                        # restart to inject the new secret

# 5. open it — https after `make trust-cert`, or plain http via the edge port :8474
open https://board.drop.localhost/        # or: http://board.drop.localhost:8474/
```

The non-secret connection config (`PGHOST: board-db-rw`, `PGUSER`/`PGDATABASE: app`, `PGSSLMODE`)
lives in [`drop.yaml`](./drop.yaml); **`PGPASSWORD` is a secret** — set write-only via `drop secrets`
(stored in the secret manager, injected as an env var, never readable again). To rotate later:
`drop db:password board-db` → `drop secrets set board PGPASSWORD --stdin` → `drop restart board`.
Manage secrets from the console (app drawer → Secrets) or `secret_*` MCP tools too.

## How it's wired

- **`src/db.ts`** — server-only `pg` Pool + a startup retry loop that `CREATE TABLE IF NOT EXISTS items`.
  Imported only from server functions, so `pg` never reaches the client bundle.
- **`src/items.functions.ts`** — `createServerFn` GET/POST functions (list/get/add/edit/remove) that
  call `db.ts`. The TanStack Start compiler turns each into a type-safe client→server RPC.
- **`src/routes/*`** — file-based routes; loaders call the GET functions for SSR, mutations call the
  POST functions then `router.invalidate()`.
- **`src/routes/healthz.ts`** — a `server.handlers` GET route returning `ok` (liveness).

## Local dev (optional)

```bash
npm install
PGHOST=localhost PGUSER=app PGPASSWORD=… PGDATABASE=app PGSSLMODE=disable npm run dev   # vite dev on :8080
npm run build && npm run start                                                          # prod node server
```

Full walkthrough (the binding model, the Node + Next.js examples, troubleshooting):
[`../DATABASE_APPS.md`](../DATABASE_APPS.md).
