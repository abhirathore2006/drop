# Drop

Self-hosted, Surge.sh-style static-site publishing for `*.drop.company.com`.
Push a built folder, get a URL. **TypeScript on Node (v24, see `.nvmrc`);
S3-compatible storage only — no database**; gated by Google login.
(Bun is used only to run the test suite.)

```
$ drop publish ./dist myapp
  ▸ packing ./dist
  ▸ dropping…
  ✓ live at https://myapp.drop.company.com
```

## How it works

- **`bin/api.ts`** — control plane (Hono): Google-ID-token auth, atomic name claim
  (`If-None-Match`), unpack upload into a versioned `files/` prefix, CAS-flip the
  live pointer in `site.json` (`If-Match`).
- **`bin/edge.ts`** — stateless serving edge (Hono): reads `site.json` (cached) →
  streams `files/<currentVersion>/...` with route-aware SPA fallback. Talks to S3 only.
- **`bin/drop.ts`** — the CLI, compiled to a single binary via `bun build --compile`.

**Metadata lives in Postgres; file bytes live in S3.** The served assets are the
only thing in object storage:

```
sites/<name>/files/<verId>/...    the served files (S3)
```

Everything else is Postgres (via Kysely; migrations run on API boot under a
`pg_advisory_lock`, so multi-replica rollouts are safe — the edge connects
read-only and never migrates):

```
users         email PK · name · role(admin|member) · status · last_login_at
sites         name PK · current_version · visibility · password_hash · config(jsonb)
site_members  (site_name, email) · role(owner|editor|viewer)   -- one owner per site
versions      (site_name, id) · published_by · file_count · bytes · config(jsonb)
auth_handles  id PK · poll_token · code_verifier · status · mode · token   -- ephemeral OAuth
```

Atomic name claim is `INSERT … ON CONFLICT DO NOTHING`; pointer flips and member
edits are `SELECT … FOR UPDATE` transactions. `GET /v1/sites` (your sites) is a
single `site_members` query; admin browse is keyset-paginated over `sites`. Moving
to a real database is what makes reporting and control practical — ad-hoc SQL over
ownership, versions, bytes, and publish activity.

Set `DROP_DATABASE_URL` (required), e.g. `postgres://drop:drop@localhost:5432/drop`.

### Roles & permissions

Two role axes, with permissions defined in code (`src/authz/permissions.ts`):

- **Platform role** (`users.role`): `admin` can see/manage all sites and users;
  `member` is a normal user. `DROP_ADMINS` (comma-separated) seeds admins on API
  boot — thereafter they're DB-managed.
- **Per-site role** (`site_members.role`): `owner` (all), `editor`
  (publish/rollback/read), `viewer` (read). `can(actor, action)` is the single
  authority check; admins are all-powerful, non-members can do nothing.

### Visibility

Each site has a `visibility` (set via `POST /v1/sites/:name/visibility`):

- **public** (default) — served openly.
- **password** — the edge requires HTTP basic-auth against `password_hash`
  (publishing a `_drop.json` with `basicAuth` also turns this on).
- **private** — only members (+ platform admins) may view. Edge enforcement
  (viewer authentication) is the next feature; **until then a private site
  returns `403` at the edge — fail closed**, never served openly. Owners can still
  manage/publish; only the served page is gated.

### Admin

`GET /v1/me` returns `{ admin: true }` for platform admins, and
`GET /v1/admin/sites?cursor=&limit=&prefix=` pages through **every** site
(name-prefix filterable) regardless of ownership. The dashboard shows an **all
sites** tab backed by the same endpoint. Admin status never bypasses per-site
ownership or `_drop.json` name-ownership.

## Local development

Uses Node (version in `.nvmrc`): `nvm use` (or `nvm install`) first.

```bash
make setup        # one-time: node (via nvm) + deps + podman VM + Floci & Postgres images
                  # behind Zscaler:  make setup CORP_CA=~/certs/Zscalerroot.cer
make start        # Floci (S3) + Postgres + api(:8473) + edge(:8474), dev-auth on
make publish DIR=./your/dist NAME=myapp
curl -H "Host: myapp.drop.localhost" http://localhost:8474/
```

Other targets: `make status`, `make logs`, `make restart`, `make stop`
(`make stop-all` also stops the podman VM), `make reset` (wipe the Floci + Postgres
volumes). Published sites + metadata persist across restarts in named volumes. The edge routes by `Host` header, so
either curl with `-H "Host: <name>.drop.localhost"` or add
`127.0.0.1 <name>.drop.localhost` to `/etc/hosts` to view in a browser.

> Prefer everything in containers? `make -C infra up` builds + runs api/edge in
> podman too (closer to prod, slower). The root `Makefile` runs the servers as Bun
> processes for faster iteration.

## Dashboard (web UI)

The control-plane API serves a dashboard at its root — open the API URL in a browser
(local: <http://localhost:8473/>). Click **Sign in with Google** (server-mediated,
sets an HttpOnly cookie), then you get a list of your sites and a per-site drawer to
roll back versions, add/remove collaborators, transfer ownership, and delete. It uses
the same `/v1/*` endpoints and identity as the CLI/MCP. Publishing stays in the CLI/MCP.

## Per-site config — `_drop.json`

Put a `_drop.json` at the root of your build folder. The API parses it at publish
time (it is **not** served as a file); the edge applies it per request. It's
versioned with the deploy — each publish can change it, and rollback restores the
matching config.

```jsonc
{
  "name": "myapp",                      // target site — lets `drop publish ./dist` skip the name arg
  "spaFallback": "index.html",          // doc for navigation misses; false to disable
  "cleanUrls": true,                    // /about → /about.html
  "notFound": "404.html",               // custom 404 document
  "redirects": [
    { "from": "/old", "to": "/new", "status": 301 },
    { "from": "/docs/*", "to": "/help/:splat", "status": 302 }
  ],
  "headers": [
    { "source": "/assets/*", "headers": { "cache-control": "public, max-age=31536000, immutable" } },
    { "source": "/*",        "headers": { "x-frame-options": "DENY" } }
  ],
  "cors": { "allowOrigins": ["https://app.paytm.com"], "allowMethods": ["GET", "HEAD"] },
  "basicAuth": { "realm": "Staging", "users": { "team": "sha256:<hex-of-password>" } }
}
```

- **cache-control** is just a `headers` rule. **HTTP password** is `basicAuth` (passwords
  plain or `sha256:<hex>`). **redirects** support a trailing `*` glob with `:splat`.
- **`name`** lets the bundle identify itself: `drop publish ./dist` (no name) uses
  `_drop.json`'s `name`; with neither, a friendly name is generated (e.g. `twilight-cherry-8f3a`).
  The server still validates **you own** that name (and rejects a bundle whose `name`
  contradicts the publish target).
- It's a static-site config in the spirit of `vercel.json` / Netlify `_redirects`+`_headers`.

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
      "args": ["-y", "--package", "git+https://bitbucket.paytm.com/scm/<team>/drop.git", "drop-mcp"],
      "env": { "DROP_API": "https://api.drop.company.com" }
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

Tools exposed: `login`, `dev_login`, `publish`, `list_sites`, `site_info`,
`rollback`, `delete_site`, `add_collaborator`, `remove_collaborator`,
`transfer_site`. (The server reads/writes the same `~/.config/drop/session.json`
as the CLI, so `login` once and both work.)

## Running the CLI (any user)

### Option 1 — `npx` straight from git (no install, recommended)

```bash
npx git+https://bitbucket.paytm.com/scm/<team>/drop.git publish ./dist myapp
# pin a tag/branch:  npx git+https://…/drop.git#v0.1.0 ls
# set the API once:  export DROP_API=https://api.drop.company.com
```

`npx` clones the repo, runs the `prepare` step (esbuild bundles the CLI into a
node-runnable `dist/drop.js` — no Bun needed), and runs it. Works on any machine
with Node 18+. (`bunx` works too once it gains git-URL support; for now use `npx`.)

### Option 2 — `install.sh` (persistent `drop` command)

```bash
git clone <repo> && cd drop
./install.sh --api https://api.drop.company.com    # idempotent, no sudo
drop publish ./dist myapp
```

Installs Bun if missing, installs deps, and puts a `drop` command on your PATH.

### Why not a single compiled binary?

`bun run build:cli` *can* produce one (`dist/drop`), but standalone binaries are
unsigned and **managed/corporate macOS kills unsigned ad-hoc binaries** (kernel +
endpoint security). Both options above run via the trusted node/bun runtime
instead, so they work everywhere. To ship an actual binary, build it in CI and
**code-sign + notarize** it with your Apple Developer ID.

## Tests

```bash
bun test                              # unit + in-process e2e (no infra needed)
cd infra && make test-integration    # live S3 (Floci) — conditional writes, claim/CAS
```

Unit tests use an in-memory blob fake that faithfully simulates ETags + conditional
writes, so the claim/CAS logic is fully covered without a running backend. The
integration tests (`src/blob/s3.integration.test.ts`) verify the same against real
Floci, including that `If-None-Match` is honored.

## Production

Login is **server-mediated**: the API is the Google OAuth client and issues its own
session tokens, so credentials live only on the server. Set on the **API**:

- `DROP_DEV_AUTH=0`
- `DROP_GOOGLE_CLIENT_ID` / `DROP_GOOGLE_CLIENT_SECRET` — a Google **"Web application"**
  client whose authorized redirect URI is `${DROP_PUBLIC_URL}/auth/callback`.
- `DROP_PUBLIC_URL` — the API's externally-reachable base (e.g. `https://api.drop.company.com`).
- `DROP_SESSION_SECRET` — HS256 key signing Drop session tokens (rotate to revoke all sessions).
- `DROP_ALLOWED_DOMAINS=paytm.com` — restrict to your Workspace domain.
- `DROP_ALLOWED_EMAILS=` *(optional)* — comma-separated allowlist of specific people,
  layered on top of the domain rule. Empty = no per-email limit. (Gates *login*; to
  revoke existing sessions immediately, rotate `DROP_SESSION_SECRET`.)
- `DROP_ADMINS=` *(optional)* — comma-separated emails granted the admin **all sites**
  view (`GET /v1/admin/sites`). Does not bypass per-site ownership.
- If the API egresses via a TLS-inspecting proxy (Zscaler), set `NODE_EXTRA_CA_CERTS`
  to the corp CA so it can reach `accounts.google.com`.

Storage + edge:
- Point `DROP_S3_*` at real AWS S3 (leave `DROP_S3_ENDPOINT` empty) or any
  S3-compatible store with conditional-write support.
- Point wildcard DNS `*.drop.company.com` + wildcard TLS at the edge; keep the edge
  reachable only on the internal network.
- **Edge caching:** set `DROP_EDGE_DISK_CACHE=/var/cache/drop` (node-local / per-pod
  dir) so the edge caches asset bytes on disk — process memory only holds the small
  version pointer, never asset bytes, so it scales to many sites without OOM. The OS
  page cache keeps hot files at RAM speed. (CloudFront optional in front.)

**Clients (CLI + MCP) need only `DROP_API`** — `drop login` / the MCP `login` tool drive
the server flow and store the returned session token.

See `../docs/superpowers/specs/2026-06-09-drop-static-publishing-design.md` for the
full design.
