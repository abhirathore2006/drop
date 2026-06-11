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

All state is S3 objects — there is **no database**:

```
sites/<name>/site.json            owner, collaborators, currentVersion  (claim/CAS)
sites/<name>/versions/<id>.json   per-publish audit
sites/<name>/files/<id>/...       the served files
```

## Local development

Uses Node (version in `.nvmrc`): `nvm use` (or `nvm install`) first.

```bash
make setup        # one-time: node (via nvm) + deps + podman VM + Floci image
                  # behind Zscaler:  make setup CORP_CA=~/certs/Zscalerroot.cer
make start        # Floci (S3) + api(:8473) + edge(:8474), dev-auth on
make publish DIR=./your/dist NAME=myapp
curl -H "Host: myapp.drop.localhost" http://localhost:8474/
```

Other targets: `make status`, `make logs`, `make restart`, `make stop`
(`make stop-all` also stops the podman VM). The edge routes by `Host` header, so
either curl with `-H "Host: <name>.drop.localhost"` or add
`127.0.0.1 <name>.drop.localhost` to `/etc/hosts` to view in a browser.

> Prefer everything in containers? `make -C deploy up` builds + runs api/edge in
> podman too (closer to prod, slower). The root `Makefile` runs the servers as Bun
> processes for faster iteration.

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
cd deploy && make test-integration    # live S3 (Floci) — conditional writes, claim/CAS
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
- If the API egresses via a TLS-inspecting proxy (Zscaler), set `NODE_EXTRA_CA_CERTS`
  to the corp CA so it can reach `accounts.google.com`.

Storage + edge:
- Point `DROP_S3_*` at real AWS S3 (leave `DROP_S3_ENDPOINT` empty) or any
  S3-compatible store with conditional-write support.
- Point wildcard DNS `*.drop.company.com` + wildcard TLS at the edge; keep the edge
  reachable only on the internal network.

**Clients (CLI + MCP) need only `DROP_API`** — `drop login` / the MCP `login` tool drive
the server flow and store the returned session token.

See `../docs/superpowers/specs/2026-06-09-drop-static-publishing-design.md` for the
full design.
