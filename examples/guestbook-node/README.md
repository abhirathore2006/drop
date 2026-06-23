# guestbook — Node.js + managed Postgres

A tiny Postgres-backed guestbook: a Drop **container app** (`drop deploy`), not a static site.
Plain Node.js (no framework) + [`pg`](https://node-postgres.com), server-rendered HTML, CRUD.
Reads the standard libpq `PG*` env vars.

## Deploy (local k3s dev stack)

**Prereqs:** the compute stack is up (`make compute-up`) and you're logged in
(`drop dev-login me you@example.com`, or `drop login`).

```bash
# 1. create the managed Postgres database
drop db create guestbook-db

# 2. build + deploy in one step — Drop builds the Dockerfile and pushes the image through
#    Drop for you (no registry creds, no manual ctr import; same command locally and in prod)
drop deploy examples/guestbook-node --build

# 3. set the DB password as a write-only SECRET (never committed), then apply it
drop db password guestbook-db                                # prints the password ONCE
printf '<that password>' | drop secrets set guestbook PGPASSWORD --stdin
drop restart guestbook                                       # restart to inject the new secret

# 4. open it — https after `make trust-cert`, or plain http via the edge port :8474
open https://guestbook.drop.localhost/        # or: http://guestbook.drop.localhost:8474/
```

> `--build` uses `docker` by default; set `DROP_BUILDER=podman` to build with podman. To create
> the app inside a team org instead of your personal org, add `--org <slug>` (likewise on
> `drop db create`). `drop push examples/guestbook-node` does just build+push and prints the ref.

<details><summary>Prebuilt-image alternative (no <code>--build</code>): build + import into k3s yourself</summary>

If you'd rather build out-of-band and reference a fixed `image:` in `drop.yaml`:

```bash
# build (use the docker.io/library/ prefix so k8s and containerd agree on the name)
podman build -t docker.io/library/guestbook-node:1 examples/guestbook-node
# import into k3s's containerd (k3s runs as the podman container `k3s`)
podman save docker.io/library/guestbook-node:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -
drop deploy examples/guestbook-node      # uses image: guestbook-node:1 from drop.yaml
```
</details>

The non-secret connection config (`PGHOST: guestbook-db-rw`, `PGUSER`/`PGDATABASE: app`, `PGSSLMODE`)
lives in [`drop.yaml`](./drop.yaml); **`PGPASSWORD` is a secret** — set write-only via `drop secrets`
(stored in the secret manager, injected as an env var, never readable again). To rotate later:
`drop db password guestbook-db` → `drop secrets set guestbook PGPASSWORD --stdin` → `drop restart guestbook`.
Manage secrets from the console (the app's page → Secrets) or `secret_*` MCP tools too.

Full walkthrough (the binding model, the Next.js example, troubleshooting):
[`../DATABASE_APPS.md`](../DATABASE_APPS.md).
