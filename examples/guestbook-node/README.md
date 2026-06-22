# guestbook — Node.js + managed Postgres

A tiny Postgres-backed guestbook: a Drop **container app** (`drop deploy`), not a static site.
Plain Node.js (no framework) + [`pg`](https://node-postgres.com), server-rendered HTML, CRUD.
Reads the standard libpq `PG*` env vars.

## Deploy (local k3s dev stack)

**Prereqs:** the compute stack is up (`make compute-up`) and you're logged in
(`drop dev-login me you@example.com`, or `drop login`).

```bash
# 1. create the managed Postgres database
drop db:create guestbook-db

# 2. build the image and import it into k3s (k3s runs as the podman container `k3s`)
podman build -t docker.io/library/guestbook-node:1 examples/guestbook-node
podman save docker.io/library/guestbook-node:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -

# 3. deploy (reads this folder's drop.yaml — the non-secret PG* config is already there)
drop deploy examples/guestbook-node

# 4. set the DB password as a write-only SECRET (never committed), then apply it
drop db:password guestbook-db                                # prints the password ONCE
printf '<that password>' | drop secrets set guestbook PGPASSWORD --stdin
drop restart guestbook                                       # restart to inject the new secret

# 5. open it — https after `make trust-cert`, or plain http via the edge port :8474
open https://guestbook.drop.localhost/        # or: http://guestbook.drop.localhost:8474/
```

The non-secret connection config (`PGHOST: guestbook-db-rw`, `PGUSER`/`PGDATABASE: app`, `PGSSLMODE`)
lives in [`drop.yaml`](./drop.yaml); **`PGPASSWORD` is a secret** — set write-only via `drop secrets`
(stored in the secret manager, injected as an env var, never readable again). To rotate later:
`drop db:password guestbook-db` → `drop secrets set guestbook PGPASSWORD --stdin` → `drop restart guestbook`.
Manage secrets from the console (app drawer → Secrets) or `secret_*` MCP tools too.

Full walkthrough (the binding model, the Next.js example, troubleshooting):
[`../DATABASE_APPS.md`](../DATABASE_APPS.md).
