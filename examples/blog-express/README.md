# blog — Express + EJS + managed Postgres

A tiny Postgres-backed blog: a Drop **container app** (`drop deploy`), not a static site.
[Express](https://expressjs.com) 5 + [EJS](https://ejs.co) server-rendered templates +
[`pg`](https://node-postgres.com), full CRUD over a `posts` table. Reads the standard libpq
`PG*` env vars.

Pages: list (`/`), view a post (`/posts/:id`), new (`/posts/new` → `POST /posts`),
edit (`/posts/:id/edit` → `POST /posts/:id`), delete (`POST /posts/:id/delete`).

## Deploy (local k3s dev stack)

**Prereqs:** the compute stack is up (`make compute-up`) and you're logged in
(`drop dev-login me you@example.com`, or `drop login`).

```bash
# 1. create the managed Postgres database
drop db:create blog-db

# 2. build the image and import it into k3s (k3s runs as the podman container `k3s`)
podman build -t docker.io/library/blog-express:1 examples/blog-express
podman save docker.io/library/blog-express:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -

# 3. deploy (reads this folder's drop.yaml — the non-secret PG* config is already there)
drop deploy examples/blog-express

# 4. set the DB password as a write-only SECRET (never committed), then apply it
drop db:password blog-db                                 # prints the password ONCE
printf '<that password>' | drop secrets set blog PGPASSWORD --stdin
drop restart blog                                        # restart to inject the new secret

# 5. open it — https after `make trust-cert`, or plain http via the edge port :8474
open https://blog.drop.localhost/             # or: http://blog.drop.localhost:8474/
```

The non-secret connection config (`PGHOST: blog-db-rw`, `PGUSER`/`PGDATABASE: app`, `PGSSLMODE`)
lives in [`drop.yaml`](./drop.yaml); **`PGPASSWORD` is a secret** — set write-only via `drop secrets`
(stored in the secret manager, injected as an env var, never readable again). To rotate later:
`drop db:password blog-db` → `drop secrets set blog PGPASSWORD --stdin` → `drop restart blog`.
Manage secrets from the console (app drawer → Secrets) or `secret_*` MCP tools too.

Full walkthrough (the binding model, the Next.js example, troubleshooting):
[`../DATABASE_APPS.md`](../DATABASE_APPS.md).
