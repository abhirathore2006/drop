# notes — Next.js + managed Postgres

A Postgres-backed notes app: a Drop **container app** (`drop deploy`), not a static site.
Next.js App Router with server actions + [`pg`](https://node-postgres.com), built as a
standalone image. Reads the standard libpq `PG*` env vars. The image bakes `PORT=8080` and
`HOSTNAME=0.0.0.0` so Next's standalone server is reachable in-pod.

## Deploy (local k3s dev stack)

**Prereqs:** the compute stack is up (`make compute-up`) and you're logged in
(`drop dev-login me you@example.com`, or `drop login`).

```bash
# 1. create the managed Postgres database
drop db:create notes-db

# 2. build the image (runs `next build` — slower) and import it into k3s
podman build -t docker.io/library/notes-next:1 examples/notes-next
podman save docker.io/library/notes-next:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -

# 3. deploy (reads this folder's drop.yaml — the non-secret PG* config is already there)
drop deploy examples/notes-next

# 4. set the DB password as a write-only SECRET (never committed), then apply it
drop db:password notes-db                                 # prints the password ONCE
printf '<that password>' | drop secrets set notes PGPASSWORD --stdin
drop restart notes                                        # restart to inject the new secret

# 5. open it — https after `make trust-cert`, or plain http via the edge port :8474
open https://notes.drop.localhost/            # or: http://notes.drop.localhost:8474/
```

The non-secret connection config (`PGHOST: notes-db-rw`, `PGUSER`/`PGDATABASE: app`, `PGSSLMODE`)
lives in [`drop.yaml`](./drop.yaml); **`PGPASSWORD` is a secret** — set write-only via `drop secrets`
(stored in the secret manager, injected as an env var, never readable again). To rotate later:
`drop db:password notes-db` → `drop secrets set notes PGPASSWORD --stdin` → `drop restart notes`.
Manage secrets from the console (app drawer → Secrets) or `secret_*` MCP tools too.

Full walkthrough (the binding model, the Node example, troubleshooting):
[`../DATABASE_APPS.md`](../DATABASE_APPS.md).
