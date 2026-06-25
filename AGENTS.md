# AGENTS.md

Guidance for AI agents (and new humans) working in this repo. Keep changes consistent with what's
already here; when in doubt, read the relevant [development decision record](development/decisions/).

## What Drop is

Drop is an internal/confidential **static-site publisher** that has grown a **Heroku/Fly-style
compute platform** on top. Two modes from **one** codebase:

- **Static** (always on): publish a folder, serve it at `https://<name>.<baseDomain>`. Metadata in
  Postgres, file bytes in S3. This is the only mode on EC2 / ECS Fargate.
- **Compute** (opt-in, Kubernetes only): container apps (`drop deploy`), managed Postgres
  (`drop db`), and write-only app secrets. Enabled when the API has a cluster (`DROP_KUBECONFIG`);
  without it `/v1/apps`, `/v1/databases` and the secret routes return `501`.

Clients are a CLI (`drop`) and an MCP server; both talk to the API over HTTP and only need
`DROP_API`. Login is server-mediated Google OAuth (the API is the OAuth client).

## Repo layout

| Path | What |
| ---- | ---- |
| `src/api` | Hono control-plane API (auth, sites, orgs, apps, databases, secrets, install.sh). |
| `src/edge` | Read-only serving edge (S3-backed, disk cache; proxies app hostnames to KEDA). |
| `src/cli`, `src/mcp` | The `drop` CLI and the MCP server. |
| `src/kube` | `KubeApiClient` — talks to Kubernetes over `node:https` + server-side apply. **No `@kubernetes/client-node`.** `FakeKube` for tests. |
| `src/blob`, `src/metastore` | S3 blob store (+ fake) and Postgres metadata (Kysely+pg; PGlite in tests). |
| `src/secrets`, `src/images` | Ports: `SecretStore` (kube/aws) and `ImageStore` (containerd/registry/noop), chosen by a factory at deploy time. |
| `src/orgs`, `src/authz`, `src/users`, `src/auth` | Organisations, `can()` permission model, users, OAuth. |
| `infra/helm/drop` | The Helm chart (api + edge; `compute.enabled` gates the PaaS). |
| `infra/terraform` | `foundation` + `ecs` (static-only) + `eks` (static or compute). |
| `infra/local` | Local stack scripts: `cluster-up.sh`, `cluster-down.sh`, `compute-up.sh`, `doctor.sh`. |
| `docs/` | The published documentation **site** (static HTML → GitHub Pages). |
| `development/` | **Dev/agent docs + decision records (ADRs).** Start at `development/README.md`. |
| `examples/` | Example apps (static + container + DB-backed). |

## Build, test, typecheck

```bash
node build.mjs          # bundle dist/{api,edge,drop,mcp}.js + dist/ui (esbuild). Run before starting.
bun test                # the test suite (PGlite + fakes; no cluster/AWS needed)
npx tsc --noEmit        # typecheck
```

- Runtime is **Node** (version pinned in `.nvmrc`); **Bun is only used for `bun test`**.
- The bundle must stay free of `@kubernetes/client-node` (see [ADR-0005](development/decisions/0005-no-kubernetes-client-node.md)).
- `drop --version` is `<package.json version>+<git short sha>`, baked at build time. Bump
  `package.json` for a release so the CLI matches the tag.

## Local development

The `Makefile` is the entry point and is **container-engine-agnostic** (podman / Docker Desktop /
Rancher Desktop dockerd / colima; override with `DROP_CONTAINER_ENGINE` or `make CE=docker`).

```bash
make doctor    # validate the whole toolchain + VM/cluster — run this first if anything is off
make setup     # one-time: node + deps + a rootful, sized podman VM (+ CORP_CA=… behind a proxy)
make start     # static stack: Floci(S3) + Postgres + api(:8473) + edge(:8474)
make up        # FULL platform: cluster (k3s+KEDA+CNPG) + Floci/PG + api/edge wired to k3s
make down      # stop everything; the k3s cluster is PRESERVED (make up resumes in ~seconds)
make nuke      # like down but wipes the cluster (rebuilt fresh next up)
make status    # what's running
```

Key local facts (details + rationale in `development/decisions/`):
- The compute plane runs **k3s as a container** (engine-agnostic), *not* Floci's EKS (which is
  Docker-only). The podman VM must be **rootful**; `make setup` handles this.
- Behind a TLS-inspecting proxy, give k3s your corp CA: `make setup CORP_CA=~/certs/<bundle>.pem`
  records it, and `make up` auto-mounts it (no need to repeat). A wrong/missing CA fails fast.
- Databases work out of the box (`make up` installs cert-manager + CloudNativePG + Barman by
  default). External Secrets installs only for the `aws` secret backend.

## Conventions

- **Match the surrounding code** — comment density, naming, idioms. TypeScript throughout.
- **Tests use in-process doubles** (`FakeKube`, `FakeBlob`, `FakeSecretStore`, `FakeImageStore`)
  wired via `createApp(Deps)`; PGlite for Postgres. No real cluster/AWS in unit tests.
- **`drop.yaml` is the only site/app config** (`_drop.json` is gone — [ADR-0008](development/decisions/0008-drop-yaml-config.md)).
- Work on a branch; **never commit secrets** (`.env` is gitignored). End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. The user opens PRs.
- The git remote URL contains an embedded token — **redact it** from any output.

## Releases

`main` is the release branch; tags are `vMAJOR.MINOR.PATCH`. For a release: merge the feature
branch into `main`, bump `package.json` so `drop --version` matches the tag, commit, tag, push.
Pushing to `main` auto-deploys `docs/` to GitHub Pages (`.github/workflows/pages.yml`).

## Where to look next

- `development/README.md` — the development guide and the index of decision records.
- `docs/` — the user-facing documentation site (architecture, deployment, CLI/MCP, roles).
