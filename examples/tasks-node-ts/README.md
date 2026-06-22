# tasks — Node.js + TypeScript + managed Postgres

A tiny Postgres-backed tasks/todo tracker: a Drop **container app** (`drop deploy`), not a static
site. Plain Node.js (no framework) with the built-in `node:http` server +
[`pg`](https://node-postgres.com), written in **TypeScript** and run directly with
[`tsx`](https://tsx.is) (no build step), server-rendered HTML, full CRUD. Reads the standard libpq
`PG*` env vars.

Pages: **list** tasks (with an all / open / done filter), **add**, **toggle done**, **delete** —
backed by a `tasks(id, title, done, created_at)` table.

## Deploy (local k3s dev stack)

**Prereqs:** the compute stack is up (`make compute-up`) and you're logged in
(`drop dev-login me you@example.com`, or `drop login`).

```bash
# 1. create the managed Postgres database
drop db:create tasks-db

# 2. build the image and import it into k3s (k3s runs as the podman container `k3s`)
podman build -t docker.io/library/tasks-node-ts:1 examples/tasks-node-ts
podman save docker.io/library/tasks-node-ts:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -

# 3. deploy (reads this folder's drop.yaml — the non-secret PG* config is already there)
drop deploy examples/tasks-node-ts

# 4. set the DB password as a write-only SECRET (never committed), then apply it
drop db:password tasks-db                                    # prints the password ONCE
printf '<that password>' | drop secrets set tasks PGPASSWORD --stdin
drop restart tasks                                           # restart to inject the new secret

# 5. open it — https after `make trust-cert`, or plain http via the edge port :8474
open https://tasks.drop.localhost/        # or: http://tasks.drop.localhost:8474/
```

The non-secret connection config (`PGHOST: tasks-db-rw`, `PGUSER`/`PGDATABASE: app`, `PGSSLMODE`)
lives in [`drop.yaml`](./drop.yaml); **`PGPASSWORD` is a secret** — set write-only via `drop secrets`
(stored in the secret manager, injected as an env var, never readable again). To rotate later:
`drop db:password tasks-db` → `drop secrets set tasks PGPASSWORD --stdin` → `drop restart tasks`.
Manage secrets from the console (app drawer → Secrets) or `secret_*` MCP tools too.

Full walkthrough (the binding model, the Next.js example, troubleshooting):
[`../DATABASE_APPS.md`](../DATABASE_APPS.md).
