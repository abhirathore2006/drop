# Drop

Self-hosted, Surge.sh-style **static-site publishing** for `*.drop.example.com` — *and* a
Heroku/Fly-style **compute platform**: deploy scale-to-zero **container apps**, provision
**managed Postgres databases**, and manage write-only **secrets**, all under the same names,
auth, and CLI/MCP/dashboard. **TypeScript on Node (v24, see `.nvmrc`); metadata in Postgres,
file bytes in S3**; gated by Google login. (Bun is used only to run the test suite.)

```
$ drop publish ./dist myapp           # static site
  ✓ live at https://myapp.drop.example.com

$ drop db create myapi-db             # managed Postgres (CloudNativePG)
$ drop deploy ./api myapi --no-start  # container app — deploy, but don't boot it yet
$ drop db password myapi-db --set-secret myapi:PGPASSWORD   # rotate DB pw straight into the app secret (never printed)
$ drop start myapi                    # first boot — already has the secret
  ✓ live at https://myapi.drop.example.com
```

> **Two planes, one product.** *Static sites* serve bytes from S3 at the edge. *Compute*
> (apps + databases + secrets) is **opt-in** — enabled only when the API has a Kubernetes
> cluster (`DROP_KUBECONFIG`); without it Drop is static-only and `/v1/apps` returns 501.
> See [Compute platform](#compute-platform) and [`examples/DATABASE_APPS.md`](examples/DATABASE_APPS.md).

## Documentation

A full HTML documentation site lives in [`docs/`](docs/) — overview, getting-started,
configuration, CLI/MCP/dashboard, roles &amp; visibility, architecture (with diagrams),
and deployment. It's plain static HTML (no build step, Mermaid vendored so it renders
offline). The same `docs/` folder is served two ways:

- **GitHub Pages** — set **Pages → Source: Deploy from a branch → `main` / `/docs`**
  (or open `docs/index.html` locally).
- **With the deployment** — the control-plane app serves it at **`/docs`**
  (e.g. `https://api.drop.example.com/docs/`), alongside the dashboard at `/` and
  login at `/auth/*`. It ships in the image, so the docs are always available next to
  the running app — no separate hosting. Override the directory with `DROP_DOCS_DIR`
  (default `docs`).

(Authoritative source-of-truth docs: this README and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).)

## How it works

- **`bin/api.ts`** — control plane (Hono): server-mediated Google login, atomic name
  claim (Postgres `INSERT … ON CONFLICT`), unpack the upload into a versioned `files/`
  prefix in S3, flip the live pointer in Postgres (row-locked transaction). Runs schema
  migrations on boot.
- **`bin/edge.ts`** — stateless serving edge (Hono): reads the site pointer from
  Postgres (cached) → streams `files/<currentVersion>/...` from S3 with route-aware SPA
  fallback and visibility enforcement.
- **`bin/drop.ts`** — the CLI (run via `npx` / a Node bundle).

> 📐 **Diagrams:** see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system
> overview, publish/serve request flows, the data model, and local-vs-prod topology.

**Metadata lives in Postgres; file bytes live in S3.** The served assets are the
only thing in object storage:

```
sites/<name>/files/<verId>/...    the served files (S3)
```

Everything else is Postgres (via Kysely; migrations run on API boot under a
`pg_advisory_lock`, so multi-replica rollouts are safe — the edge connects
read-only and never migrates):

```
users           email PK · name · role(admin|member) · status · last_login_at
sites           name PK · type(site|app|database) · current_version · visibility ·
                password_hash · runtime_state(running|stopped) · config(jsonb)
site_members    (site_name, email) · role(owner|editor|viewer)   -- one owner per site
versions        (site_name, id) · published_by · file_count · bytes · config(jsonb)
app_secret_keys (app, key) · fingerprint · updated_by · updated_at   -- secret KEY NAMES only, never values
auth_handles    id PK · poll_token · code_verifier · status · mode · token   -- ephemeral OAuth
```

`sites.type` is the workload discriminator — **`site`** (static), **`app`** (container), or
**`database`** (managed Postgres) — all sharing the one name namespace, so a name can't be two
things. Static sites use S3 bytes; apps and databases use the [compute plane](#compute-platform).

Atomic name claim is `INSERT … ON CONFLICT DO NOTHING`; pointer flips and member
edits are `SELECT … FOR UPDATE` transactions. `GET /v1/sites` (your sites) is a
single `site_members` query; admin browse is keyset-paginated over `sites`. Moving
to a real database is what makes reporting and control practical — ad-hoc SQL over
ownership, versions, bytes, and publish activity.

Set `DROP_DATABASE_URL` (required), e.g. `postgres://drop:drop@localhost:5432/drop`.

### Roles & permissions

Three role axes, with permissions defined in code (`src/authz/permissions.ts`):

- **Platform role** (`users.role`): `admin` can see/manage all sites and users;
  `member` is a normal user. `DROP_ADMINS` (comma-separated) seeds admins on API
  boot — thereafter they're DB-managed.
- **Org role** (`org_members.role`, applies **org-wide** — see [Organisations](#organisations)):
  `owner` & `admin` (everything), `member` (read, logs, publish, deploy, db:create, rollback,
  configure — i.e. ship + manage config/**secrets**, but **not** share/transfer/delete a
  resource), `viewer` (read only).
- **Per-site role** (`site_members.role`): `owner` (all), `editor`
  (publish/deploy/db:create/rollback/restart-stop-start/read+logs), `viewer` (read only).

`can(actor, action)` is the single authority check; the effective permission is the **union** of
platform-admin (all-powerful) **OR** the actor's org role on the resource's owning org **OR** any
per-site grant — the broader of the two role layers wins, never the narrower, and `site_members`
remains an additive grant on top of the org role. Compute-relevant actions: `deploy` & `db:create`
(editor/member+), `logs` & lifecycle (editor/member+ — logs can echo env, so above plain
`read`/viewer), `configure` (org member+ / site owner — visibility, DB password, **secrets**),
`delete`/`transfer`/`share` (org owner-admin / site owner only).

### Organisations

Every resource (site / app / database) belongs to **exactly one organisation** — the grouping that
carries the org-wide roles above (source: `src/orgs/store.ts`, `src/api/server.ts` `/v1/orgs*`).
There are two kinds:

- **Personal org** — auto-created for each user on first login. Its namespace is your **existing
  tenant namespace**, so nothing moves: your current workloads already live there.
- **Team org** — created explicitly (`drop org create <slug>`) and gets its **own** namespace.

```bash
drop org create <slug> [name]    # create a team org (you become owner)
drop org ls                      # your orgs + your role in each
drop org members <slug>          # show an org's members
drop org add <slug> <email> [role]   # add/update a member (owner|admin|member|viewer; default member)
drop org rm  <slug> <email>      # remove a member
```

`--org <slug>` shows up exactly where an org is a **choice**, never as redundant noise:

```bash
# create target — where a NEW resource lands (omit → your personal org)
drop publish ./dist mysite --org acme
drop deploy  ./api  myapi  --org acme
drop db create myapi-db    --org acme

# list filter — only this org's resources
drop ls --org acme

# re-home — move an existing resource into a team org (app workload torn down → redeploy + re-set
# secrets in the new org; databases are stateful and blocked)
drop transfer myapp --org acme        # vs `drop transfer myapp bob@example.com` (to a user)
```

Per-resource commands — `share`/`unshare`, `secrets`, `restart`/`stop`/`start`, `rollback`,
`info`, `rm`, `db password` — take a **globally-unique resource name** that already identifies the
resource and its org, so they don't take `--org`. Org-*wide* access is granted with `drop org add`
(an org role applies to every resource in the org), which is the additive layer over per-resource
collaborators (`drop share`).

The same is exposed over MCP as `org_create`, `org_list`, and `org_add_member` (with an `org` arg
on `deploy`/`db_create` to choose a team org).

### Visibility

Each site has a `visibility` (set via `POST /v1/sites/:name/visibility`):

- **public** (default) — served openly.
- **password** — the edge requires HTTP basic-auth against `password_hash`
  (publishing a `drop.yaml` with `site.basicAuth` also turns this on).
- **private** — only members (+ platform admins) may view. Edge enforcement
  (viewer authentication) is the next feature; **until then a private site
  returns `403` at the edge — fail closed**, never served openly. Owners can still
  manage/publish; only the served page is gated.

### Admin

`GET /v1/me` returns `{ admin: true }` for platform admins, and
`GET /v1/admin/sites?cursor=&limit=&prefix=` pages through **every** site
(name-prefix filterable) regardless of ownership. The dashboard shows an **all
sites** tab backed by the same endpoint. Admin status never bypasses per-site
ownership or `drop.yaml` `site.name` name-ownership.

## Compute platform

Beyond static sites, Drop runs **container apps** and **managed databases** on Kubernetes
(EKS in prod; k3s-on-podman locally), with the same names/auth/CLI. **Opt-in:** the API enables
it only when `DROP_KUBECONFIG` is set; otherwise `/v1/apps` & `/v1/databases` return `501`.
Per-tenant isolation: every owner gets a namespace `drop-t-<slug(email)>-<hash>` with a
default-deny **NetworkPolicy**, **ResourceQuota**/**LimitRange**, and PSA labels; prod adds the
**gVisor** runtime for untrusted images.

### Container apps

The easiest path is to let Drop **build and push the image for you** — no registry credentials on
the client, and the *same command* works locally and in prod (source: `src/images/*`,
`src/cli/build-push.ts`, `src/api/server.ts` `PUT /v1/apps/:name/image`):

```bash
drop deploy ./api --build                      # build ./api/Dockerfile → push through Drop → deploy
drop deploy ./api --build -f Dockerfile.prod    # build a specific Dockerfile (per-env); implies --build
drop push   ./api [name]                        # just build+push; prints the in-cluster ref (drop.local/<app>:<tag>)
```

`--build` builds the Dockerfile in `<dir>`, streams a `docker save` tarball to the Drop API, which
makes it pullable by the cluster (**local:** imports into the k3s node's containerd; **prod:**
pushes to a registry / ECR), then deploys — so a developer never needs registry creds. The CLI
builder is `docker` by default; set **`DROP_BUILDER=podman`** to use podman. To build a specific
Dockerfile (e.g. multiple per-env files), pass **`-f, --dockerfile <path>`** (relative to your
CWD, like docker's `-f`; it implies `--build`). On the server,
`DROP_IMAGE_BACKEND` selects `containerd` (default, local) or `registry` (prod). (Image push is
**CLI-only today** — there is no MCP tool for it yet; in-cluster builds without a local Docker are
a future item.)

**Deploying an app that needs secrets at first boot** (e.g. a DB password): an app with `scale.min:
1` starts a pod the moment it's deployed, so deploying *before* its secret exists makes that first
pod crash-loop. Use **`--no-start`** to deploy without booting, set the secret, then `drop start`:

```bash
drop deploy ./api --build --no-start             # build + push + register, but don't start
drop db password api-db --set-secret api:PGPASSWORD   # rotate the DB pw straight into the app secret (never printed)
drop start api                                   # first boot — already has the secret
```

`drop db password <db> --set-secret <app>:<KEY>` rotates the database password and writes it
**directly** into the app's write-only secret — the plaintext never returns to your terminal. Add
`--show` to also print it; or use the two-step `drop db password <db>` → `drop secrets set` if you
prefer.

The `app:` section in `drop.yaml` declares the rest. With `--build` Drop supplies the image; or
**bring your own** prebuilt image by setting `app.image` (no `--build`):

```yaml
app:
  name: myapi
  image: myapi:1            # BYO prebuilt image (omit/override when you use `drop deploy --build`)
  services: [{ internal_port: 8080 }]
  scale: { min: 0, max: 3 } # min:0 = scale-to-zero
  resources: { cpu: "500m", memory: "512Mi" }
  env: { LOG_LEVEL: info }  # non-secret config (secrets go via `drop secrets`, below)
```

The API translates this to a **Deployment + Service + HTTPScaledObject** (KEDA HTTP add-on) +
ingress NetworkPolicy. Apps **scale to zero** when idle; the **edge** dispatches
`<name>.drop.example.com` to the KEDA interceptor, which wakes the pod on the first request.
v1 is one HTTP service, 443-only.

### Managed databases (CloudNativePG)

```bash
drop db create myapi-db          # a single-instance Postgres 18 in your namespace
drop db password myapi-db        # set/rotate the `app` role password — printed ONCE
```

CloudNativePG provisions a `Cluster`; backups go to S3 via the **Barman Cloud Plugin**
(`ObjectStore` + `ScheduledBackup`, local Floci or prod IRSA). Apps connect in-namespace to the
`<db>-rw` service as user/db `app`; the connection ref (host/port/db/user + the `<db>-app`
Secret) is returned — **never the password**. `db password` rotates it via a one-shot in-namespace
`ALTER ROLE` Job (no superuser). Databases can't be transferred (stateful) and tear down cleanly.

### Secrets (write-only)

Per-app secrets — DB passwords, API keys, tokens — are **set/rotated/deleted but never read
back**, and injected as env vars:

```bash
printf "$PW" | drop secrets set myapi DATABASE_PASSWORD --stdin   # stdin → not in shell history
drop secrets ls myapi            # key names + when changed — NEVER values
drop restart myapi               # secrets apply on the next restart/deploy
```

A `SecretStore` **port** picks the backend at deploy time (`DROP_SECRET_BACKEND`): **`kube`**
(default — writes the `<app>-secret` Secret directly) or **`aws`** (**AWS Secrets Manager** at
`drop/<ns>/<app>/<KEY>`, synced into the cluster by the **External Secrets Operator**; locally it
runs against **Floci's** SM emulation, so the local stack exercises the prod path). Every backend
converges on the `<app>-secret` Secret the Deployment `envFrom`s (listed last → a secret wins over
a same-named config value). Values never touch `drop.yaml`/git, API/MCP/CLI responses, logs, or
the metastore — only the secret manager + the pod env. Owner/admin only.

### Lifecycle

```bash
drop restart <app>   # roll the pods (apply new secrets/config)
drop stop <app>      # TRUE offline — scale to 0 AND don't wake on traffic (pause KEDA)
drop start <app>     # restore the configured scale
```

Editor+. `stop` survives redeploys (`runtime_state=stopped`). All of the above are also in the
**console** (the full-page `/app/<name>` view: status, logs, secrets, lifecycle) and as **MCP
tools**.

### Example apps

A catalog of runnable DB-backed apps lives in [`examples/`](examples/) — each connects to a managed
Drop Postgres via the standard libpq `PG*` env vars plus a write-only `PGPASSWORD` secret:
**guestbook-node** (Node + `pg` + HTML), **tasks-node-ts** (Node + TypeScript via `tsx`),
**blog-express** (Express 5 + EJS), **notes-next** (Next.js, list + detail/edit),
**board-tanstack** (TanStack Start), and **chat-ws** (a WebSocket chat app). The full walkthrough —
create a DB, map it into the app's env, build, deploy, verify — is in
[`examples/DATABASE_APPS.md`](examples/DATABASE_APPS.md).

> **WebSockets — known limitation.** `examples/chat-ws` is a real WS chat app, but WebSockets do
> **not** yet traverse the public edge: the edge proxy doesn't tunnel HTTP `Upgrade` requests, and
> the KEDA HTTP add-on interceptor returns `403` for WS upgrades. For now, exercise chat-ws via
> `kubectl port-forward` straight to the pod. The fix plan is
> [`planning/2026-06-23-websocket-support-plan.md`](planning/2026-06-23-websocket-support-plan.md).

## Local development

Uses Node (version in `.nvmrc`): `nvm use` (or `nvm install`) first.

```bash
make setup        # one-time: node (via nvm) + deps + podman VM + Floci & Postgres images
                  # behind a TLS-inspecting proxy:  make setup CORP_CA=~/certs/your-root-ca.cer
make start        # Floci (S3) + Postgres + api(:8473) + edge(:8474), dev-auth on
make publish DIR=./your/dist NAME=myapp
curl -H "Host: myapp.drop.localhost" http://localhost:8474/
```

Other targets: `make status`, `make logs`, `make restart`, `make stop`
(`make stop-all` also stops the podman VM), `make reset` (wipe the Floci + Postgres
volumes). Published sites + metadata persist across restarts in named volumes. The edge routes by `Host` header, so
either curl with `-H "Host: <name>.drop.localhost"` or add
`127.0.0.1 <name>.drop.localhost` to `/etc/hosts` to view in a browser.

### Compute plane (local)

The static stack above needs no cluster. To exercise **apps / databases / secrets**, bring up the
local Kubernetes compute plane — a single-node **k3s** (in podman) with **KEDA** + the HTTP
add-on (scale-to-zero), **CloudNativePG** + the Barman Cloud Plugin (managed Postgres), and the
**External Secrets Operator** + a `floci` `ClusterSecretStore` (so the `aws` secrets backend runs
against Floci's Secrets-Manager emulation):

```bash
make compute-up                  # k3s + KEDA + CNPG + ESO (runs infra/local/compute-up.sh; writes ~/.kube/drop-local.config)
# run the API with the cluster + the aws-on-Floci secrets backend:
DROP_KUBECONFIG=~/.kube/drop-local.config DROP_SECRET_BACKEND=aws \
  DROP_SECRET_MANAGER_ENDPOINT=http://localhost:4566 DROP_SECRET_STORE_NAME=floci ... node dist/api.js
```

Then `drop deploy`, `drop db create`, `drop secrets set`, and `drop restart/stop/start` work
locally exactly as in prod. See [`examples/DATABASE_APPS.md`](examples/DATABASE_APPS.md) for the
end-to-end flow (build an image, import it into k3s, create a DB, set a secret, deploy).

### Trusted local HTTPS (optional, via nginx in containers)

The `make` flow above serves over plain `http://…:<port>`. For **trusted HTTPS with
stable names** — and a setup that mirrors production — run the whole stack in
containers behind **nginx** (works on macOS, Linux, and Windows via Docker/Podman
Desktop or WSL2):

```bash
make stop                                              # free the shared host ports first
node build.mjs                                         # build the self-contained bundles
./infra/nginx/gen-certs.sh                             # local TLS cert for *.drop.localhost
docker compose -f infra/docker-compose.yml up --build  # postgres + floci + api + edge + nginx
```

You then get, behind nginx on `:443`:

- `https://api.drop.localhost/` → control plane + dashboard (and `/docs/`)
- `https://<name>.drop.localhost/` → any published site (edge, wildcard)

nginx terminates TLS on `:443` and routes by hostname — `api.drop.localhost` → api,
`*.drop.localhost` → edge — setting `X-Forwarded-Host` (which the edge honors), so the
site name survives the proxy. This is the same shape as the production ingress
(ALB/Ingress), just local. `gen-certs.sh` uses [mkcert](https://github.com/FiloSottile/mkcert)
for a browser-trusted cert if installed, else a self-signed one — in which case run
**`make trust-cert`** to add it to your OS trust store (macOS/Linux/Windows, OS-detected;
`make untrust-cert` reverses it) and clear the browser warning.

The images **copy the prebuilt esbuild bundles** (hence `node build.mjs` first) — there's
no in-image `npm install`, so they build offline / behind a TLS-inspecting proxy.

> - **Ports:** this stack reuses the `make start` host ports (8473/8474/5432/4566) plus
>   `443` — run `make stop` first. If the host can't bind `443` (rootless Docker/Podman)
>   or it's taken, set a high port: `DROP_HTTPS_PORT=8443 docker compose … up --build`
>   → `https://api.drop.localhost:8443/`.
> - **Corp proxy:** to trust your organization's root CA at *runtime* (e.g. Google login
>   egress through a TLS-inspecting proxy), drop it in [`infra/ca/`](infra/ca/)`*.crt`. If
>   the BuildKit builder can't pull the base image through the proxy, build with the daemon
>   builder: `DOCKER_BUILDKIT=0 docker compose … build`.
> - Real Google login locally still uses the loopback URL (Google won't accept a
>   `.localhost` OAuth redirect) — HTTPS here shines for dev-auth, the dashboard, and sites.

> Prefer everything in containers? `make -C infra up` builds + runs api/edge in
> podman too (closer to prod, slower). The root `Makefile` runs the servers as Bun
> processes for faster iteration.

## Dashboard (web UI)

The control-plane API serves a **React** dashboard ("console") at its root — open the API URL in
a browser (local: <http://localhost:8473/>). Click **Sign in with Google** (server-mediated, sets
an HttpOnly cookie), then you get your workloads grouped by type (**sites / apps / databases**)
with **live status**. Clicking a workload opens it as its **own full page / route**
(`/site/<name>`, `/app/<name>`, `/database/<name>`, plus `/admin`) — deep-linkable and
refresh-safe — with detailed panel sections rather than an inline drawer: roll back versions
(sites), image/scale/**logs** + **lifecycle** (restart/stop/start) and a write-only **Secrets**
panel (apps), connection ref + **set/rotate password** (databases), plus collaborators, transfer,
and delete. Admins get an **all-workloads** view (`/admin`) with type/owner filters and user
suspend. Same `/v1/*` endpoints and identity as the CLI/MCP. Publishing/deploying stays in the
CLI/MCP.

## Per-site config — `drop.yaml` (`site:`)

Put a `drop.yaml` at the root of your build folder with the static config under a `site:`
key (the same file holds the `app:` section for container apps). The API parses it at publish
time (it is **not** served as a file); the edge applies it per request. It's versioned with the
deploy — each publish can change it, and rollback restores the matching config.

```yaml
site:
  name: myapp                 # target site — lets `drop publish ./dist` skip the name arg
  spaFallback: index.html     # doc for navigation misses; false to disable
  cleanUrls: true             # /about → /about.html
  notFound: 404.html          # custom 404 document
  redirects:
    - { from: /old, to: /new, status: 301 }
    - { from: /docs/*, to: /help/:splat, status: 302 }
  headers:
    - source: /assets/*
      headers: { cache-control: "public, max-age=31536000, immutable" }
    - source: /*
      headers: { x-frame-options: DENY }
  cors: { allowOrigins: ["https://app.example.com"], allowMethods: [GET, HEAD] }
  basicAuth: { realm: Staging, users: { team: "sha256:<hex-of-password>" } }
```

- **cache-control** is just a `headers` rule. **HTTP password** is `basicAuth` (passwords
  plain or `sha256:<hex>`). **redirects** support a trailing `*` glob with `:splat`.
- **`name`** lets the bundle identify itself: `drop publish ./dist` (no name) uses
  `drop.yaml`'s `site.name`; with neither, a friendly name is generated (e.g. `twilight-cherry-8f3a`).
  The server still validates **you own** that name (and rejects a bundle whose `name`
  contradicts the publish target).
- It's a static-site config in the spirit of `vercel.json` / Netlify `_redirects`+`_headers`.
  See [`examples/`](examples/) for runnable `drop.yaml` site samples.

## Use it from an AI client (MCP — no CLI needed)

Drop ships an **MCP server**, so any MCP client (Claude Code/Desktop, Cursor, …) can
publish and manage sites in natural language — *"publish ./dist as myapp"*. The
client launches the server on demand via `npx` (nothing to install).

Add to your MCP config (e.g. Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "drop": {
      "command": "npx",
      "args": ["-y", "--package", "git+https://git.example.com/scm/<team>/drop.git", "drop-mcp"],
      "env": { "DROP_API": "https://api.drop.example.com" }
    }
  }
}
```

The client needs **only `DROP_API`** — login is server-mediated (the Drop API owns
the Google credentials and hands back a session token), so no Google client id/secret
lives on anyone's machine.

For local dev against `make start`, point it at the built server and dev-auth:

```json
{ "mcpServers": { "drop": {
  "command": "node", "args": ["/abs/path/to/drop/dist/mcp.js"],
  "env": { "DROP_API": "http://localhost:8473", "DROP_DEV_AUTH": "1" } } } }
```

Tools exposed: `login`, `dev_login`, `publish`, **`deploy`** (container app), **`db_create`**
(managed Postgres), **`secret_set`/`secret_list`/`secret_delete`** (write-only app secrets),
**`app_restart`/`app_stop`/`app_start`** (lifecycle), **`org_create`/`org_list`/`org_add_member`**
(organisations), `list_sites`, `site_info`, `rollback`,
`delete_site`, `add_collaborator`, `remove_collaborator`, `transfer_site`. (There is **no**
image-push MCP tool yet — `drop push` / `drop deploy --build` are CLI-only.) (The server
reads/writes the same `~/.config/drop/session.json` as the CLI, so `login` once and both work.)

## Running the CLI (any user)

### Option 1 — `npx` straight from git (no install, recommended)

```bash
npx git+https://git.example.com/scm/<team>/drop.git publish ./dist myapp
# pin a tag/branch:  npx git+https://…/drop.git#v0.1.0 ls
# set the API once:  export DROP_API=https://api.drop.example.com
```

`npx` clones the repo, runs the `prepare` step (`node build.mjs cli mcp` — esbuild
bundles both the CLI into `dist/drop.js` and the MCP server into `dist/mcp.js`, which
is what makes `npx … drop-mcp` work without a separate build; no Bun needed), and runs
it. Works on any machine with Node 18+. (`bunx` works too once it gains git-URL
support; for now use `npx`.)

### Option 2 — `install.sh` (persistent `drop` command)

```bash
git clone <repo> && cd drop
./install.sh --api https://api.drop.example.com    # idempotent, no sudo
drop publish ./dist myapp
```

Installs Bun if missing, installs deps, and puts a `drop` command on your PATH.

### Updating the CLI

Check your version any time with **`drop --version`** (e.g. `0.1.0+<sha>`).

- **Server-served install** (`curl <API>/install.sh | sh` — the installer the deployed API serves):
  just run **`drop update`**. It prints the **current → target** version (the target read from the
  instance's `/version`), and — unless you're already current — re-runs the installer recorded at
  install time (`installUrl` in `~/.config/drop/config.json`) to pull the latest CLI. `--force`
  re-installs anyway; override the source with `drop --api <url> update`.
- **`npx` (Option 1)**: nothing to update — each run fetches the pinned ref.
- **Dev clone (Option 2)**: the wrapper runs the repo's live source, so `git pull` updates it.

### Why not a single compiled binary?

`bun run build:binary` *can* produce one (`dist/drop`), but standalone binaries are
unsigned and **managed/corporate macOS kills unsigned ad-hoc binaries** (kernel +
endpoint security). Both options above run via the trusted node/bun runtime
instead, so they work everywhere. To ship an actual binary, build it in CI and
**code-sign + notarize** it with your Apple Developer ID.

## Tests

```bash
bun test                              # unit + in-process e2e (Postgres via PGlite; no infra needed)
cd infra && make test-integration    # live S3 (Floci) — blob store conditional writes
```

Unit + integration tests run against **PGlite** (in-process Postgres), so the real
SQL and migrations are exercised with no running backend — atomic name claim
(`INSERT … ON CONFLICT DO NOTHING`), the row-locked pointer flip, roles, and
visibility are all covered. The S3 integration tests
(`src/blob/s3.integration.test.ts`) validate the blob store against real Floci
(including its `If-None-Match` primitive — now used only for blob safety, not the
name claim, which is a Postgres unique constraint).

## Production

Login is **server-mediated**: the API is the Google OAuth client and issues its own
session tokens, so credentials live only on the server. Set on the **API**:

- `DROP_DEV_AUTH=0`
- `DROP_GOOGLE_CLIENT_ID` / `DROP_GOOGLE_CLIENT_SECRET` — a Google **"Web application"**
  client whose authorized redirect URI is `${DROP_PUBLIC_URL}/auth/callback`.
- `DROP_PUBLIC_URL` — the API's externally-reachable base (e.g. `https://api.drop.example.com`).
- `DROP_SESSION_SECRET` — HS256 key signing Drop session tokens (rotate to revoke all sessions).
- `DROP_ALLOWED_DOMAINS=example.com` — restrict to your Workspace domain.
- `DROP_ALLOWED_EMAILS=` *(optional)* — comma-separated allowlist of specific people,
  layered on top of the domain rule. Empty = no per-email limit. (Gates *login*; to
  revoke existing sessions immediately, rotate `DROP_SESSION_SECRET`.)
- `DROP_ADMINS=` *(optional)* — comma-separated emails granted the admin **all sites**
  view (`GET /v1/admin/sites`). Does not bypass per-site ownership.
- If the API egresses via a TLS-inspecting proxy, set `NODE_EXTRA_CA_CERTS`
  to the corp CA so it can reach `accounts.google.com`.

Storage + edge:
- Set `DROP_DATABASE_URL` to a managed Postgres (RDS / CloudSQL); the API migrates
  it on boot under an advisory lock. Point `DROP_S3_*` at real AWS S3 (leave
  `DROP_S3_ENDPOINT` empty) or any S3-compatible store for the file bytes.
- Point wildcard DNS `*.drop.example.com` + wildcard TLS at the edge; keep the edge
  reachable only on the internal network.
- **Edge caching:** set `DROP_EDGE_DISK_CACHE=/var/cache/drop` (node-local / per-pod
  dir) so the edge caches asset bytes on disk. The long-lived in-memory cache holds
  only the small per-site pointer (10s TTL) — asset bytes are served from the disk
  cache (OS page cache keeps hot files at RAM speed) or fetched per-request from S3
  and freed after the response, so it scales to many sites without retaining bytes.
  (CloudFront optional in front.)

Compute (apps + databases + secrets) — *only if you enable the compute plane*:
- `DROP_KUBECONFIG` — path to the cluster kubeconfig (enables `/v1/apps` + `/v1/databases`).
- `DROP_BLOCKED_EGRESS_CIDRS` — the cluster pod+service CIDRs, excluded from tenants' HTTPS
  egress allowlist (defaults to `10.0.0.0/8` = local k3s only; **set the real EKS CIDRs** or
  cross-tenant egress silently stays open).
- `DROP_DB_BACKUP_ROLE_ARN` — IRSA role for CNPG → S3 backups (prod fails closed without it).
- `DROP_SECRET_BACKEND=aws` + `DROP_SECRET_STORE_NAME=<ESO ClusterSecretStore>` (region/IRSA via
  the SDK default chain) to store app secrets in **AWS Secrets Manager** behind the External
  Secrets Operator. Default `kube` keeps them in etcd Secrets (use a KMS encryption-at-rest
  provider). Install KEDA + the HTTP add-on, CloudNativePG + the Barman Cloud Plugin, and (for
  the `aws` backend) the External Secrets Operator in the cluster.

**Clients (CLI + MCP) need only `DROP_API`** — `drop login` / the MCP `login` tool drive
the server flow and store the returned session token.

Designs & plans: static publishing
(`docs/superpowers/specs/2026-06-09-drop-static-publishing-design.md`), the compute hardening &
completion plan (`planning/2026-06-21-compute-hardening-and-completion-plan.md`), the admin
console (`planning/2026-06-22-admin-console-plan.md`), and app secrets + lifecycle
(`planning/2026-06-22-app-secrets-design.md` / `-plan.md`).
