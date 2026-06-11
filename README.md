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
make start        # Floci (S3) + api(:8080) + edge(:8090), dev-auth on
make publish DIR=./your/dist NAME=myapp
curl -H "Host: myapp.drop.localhost" http://localhost:8090/
```

Other targets: `make status`, `make logs`, `make restart`, `make stop`
(`make stop-all` also stops the podman VM). The edge routes by `Host` header, so
either curl with `-H "Host: <name>.drop.localhost"` or add
`127.0.0.1 <name>.drop.localhost` to `/etc/hosts` to view in a browser.

> Prefer everything in containers? `make -C deploy up` builds + runs api/edge in
> podman too (closer to prod, slower). The root `Makefile` runs the servers as Bun
> processes for faster iteration.

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

- Set `DROP_DEV_AUTH=0`; configure `DROP_GOOGLE_CLIENT_ID` /
  `DROP_GOOGLE_CLIENT_SECRET` and `DROP_ALLOWED_DOMAINS=paytm.com`.
- Create a Google OAuth **Desktop app** client; add `http://localhost:8976/callback`
  to its redirect URIs (used by `drop login`).
- Point `DROP_S3_*` at real AWS S3 (leave `DROP_S3_ENDPOINT` empty) or any
  S3-compatible store with conditional-write support.
- Point wildcard DNS `*.drop.company.com` + wildcard TLS at the edge; keep the edge
  reachable only on the internal network.

See `../docs/superpowers/specs/2026-06-09-drop-static-publishing-design.md` for the
full design.
