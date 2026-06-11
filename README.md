# Drop

Self-hosted, Surge.sh-style static-site publishing for `*.drop.company.com`.
Push a built folder, get a URL. **TypeScript on Bun; S3-compatible storage only —
no database**; gated by Google login.

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

## Local development (Podman)

```bash
cd deploy
make up        # floci (S3 emulator) + api(:8080) + edge(:8090), dev-auth on
```

Publish and view a site:

```bash
./install.sh --api http://localhost:8080   # installs the `drop` command for your user
drop dev-login alice alice@paytm.com
mkdir -p /tmp/site && echo '<html>hi</html>' > /tmp/site/index.html
drop publish /tmp/site myapp
curl -H "Host: myapp.drop.localhost" http://localhost:8090/
```

Tear down: `cd deploy && make down`.

## Installing the CLI (any user)

```bash
git clone <repo> && cd drop
./install.sh --api https://api.drop.company.com
```

`install.sh` ensures Bun is present, installs dependencies, and drops a `drop`
command into a bin dir on your PATH (no sudo). It's idempotent and works on macOS
and Linux. `--api <url>` bakes a default control-plane URL (override anytime with
`DROP_API` or `--api`).

### Why a wrapper, not a binary

`bun run build:cli` *can* produce a single self-contained binary (`dist/drop`),
but standalone binaries are unsigned and **managed/corporate macOS kills unsigned
ad-hoc binaries** (kernel + endpoint security). The installer instead ships a tiny
wrapper around the already-trusted `bun` runtime, which runs everywhere. To
distribute an actual binary, build it in CI and **code-sign + notarize** it with
your Apple Developer ID.

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
