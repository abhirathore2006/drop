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
drop db create notes-db

# 2. build + deploy in one step — Drop builds the Dockerfile (this one runs `next build`, so it's
#    slower) and pushes the image through Drop for you (no registry creds, no manual ctr import)
drop deploy examples/notes-next --build --no-start

# 3. set the DB password as a write-only SECRET (never committed), then apply it
drop db password notes-db                                 # prints the password ONCE
printf '<that password>' | drop secrets set notes PGPASSWORD --stdin
drop start notes                                        # first boot, already has the password

# 4. open it — https after `make trust-cert`, or plain http via the edge port :8474
open https://notes.drop.localhost/            # or: http://notes.drop.localhost:8474/
```

> `--build` uses `docker` by default; set `DROP_BUILDER=podman` to build with podman. To create
> the app inside a team org instead of your personal org, add `--org <slug>` (likewise on
> `drop db create`). `drop push examples/notes-next` does just build+push and prints the ref.

<details><summary>Prebuilt-image alternative (no <code>--build</code>): build + import into k3s yourself</summary>

If you'd rather build out-of-band and reference a fixed `image:` in `drop.yaml`:

```bash
# build (runs `next build` — slower; use the docker.io/library/ prefix so k8s + containerd agree)
podman build -t docker.io/library/notes-next:1 examples/notes-next
# import into k3s's containerd (k3s runs as the podman container `k3s`)
podman save docker.io/library/notes-next:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -
drop deploy examples/notes-next      # uses image: notes-next:1 from drop.yaml
```
</details>

The non-secret connection config (`PGHOST: notes-db-rw`, `PGUSER`/`PGDATABASE: app`, `PGSSLMODE`)
lives in [`drop.yaml`](./drop.yaml); **`PGPASSWORD` is a secret** — set write-only via `drop secrets`
(stored in the secret manager, injected as an env var, never readable again). To rotate later:
`drop db password notes-db` → `drop secrets set notes PGPASSWORD --stdin` → `drop start notes`.
Manage secrets from the console (the app's page → Secrets) or `secret_*` MCP tools too.

Full walkthrough (the binding model, the Node example, troubleshooting):
[`../DATABASE_APPS.md`](../DATABASE_APPS.md).
