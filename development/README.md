# Development

Working notes for developing Drop — for AI agents and humans. The repo-level entry point is
[`AGENTS.md`](../AGENTS.md); this folder goes deeper and records **why** things are the way they are.

## Contents

- [`decisions/`](decisions/) — Architecture/Engineering Decision Records (ADRs). Read these before
  changing the area they cover; if you make a new significant decision, add one.
- This file — the development guide (setup, workflow, testing, gotchas).

## Quick start

```bash
make doctor            # validate tools + VM/cluster (run first if anything misbehaves)
make setup             # one-time: node (.nvmrc) + deps + rootful sized podman VM
make start             # static stack only (publish + serve sites)
make up                # full platform (adds the k3s compute plane: apps + databases + secrets)
```

Behind a TLS-inspecting proxy (e.g. Zscaler), record your CA once:
`make setup CORP_CA=~/certs/<bundle>.pem` — then `make up` auto-trusts it.

## Architecture in one screen

- **api** (`src/api`) — Hono control plane: auth, sites, orgs, members, apps, databases, secrets,
  and the served `install.sh`. Runs Postgres migrations on boot under an advisory lock
  (multi-replica safe).
- **edge** (`src/edge`) — read-only serving. Resolves `Host` → site, streams bytes from S3 with a
  per-pod disk cache. For container apps it proxies to the KEDA HTTP interceptor.
- **State** — Postgres holds all metadata (`src/metastore`, Kysely + pg; PGlite in tests); S3 holds
  file bytes (`src/blob`). The chart bundles neither — they're the platform's responsibility.
- **Compute** — `src/kube/KubeApiClient` drives Kubernetes directly (no client library). Apps use
  KEDA (scale-to-zero + HTTP routing); databases use CloudNativePG + the Barman Cloud Plugin;
  secrets use a pluggable `SecretStore` (k8s Secrets, or AWS Secrets Manager via External Secrets).
- **Tenancy** — per-owner namespaces, default-deny NetworkPolicies, ResourceQuota/LimitRange,
  optional gVisor sandbox. Organisations own resources; `src/authz/can()` = platform-admin ∪
  org-role ∪ site-role.
- **Ports & factories** — `SecretStore` (kube/aws) and `ImageStore` (containerd/registry/noop) are
  interfaces chosen by a factory from env at deploy time, so the same code runs local and prod.

## Testing

- `bun test` — fast, hermetic. Kubernetes/blob/secrets/images are in-process **fakes**
  (`FakeKube`, `FakeBlob`, `FakeSecretStore`, `FakeImageStore`) injected via `createApp(Deps)`;
  Postgres is PGlite. No cluster or AWS needed.
- `npx tsc --noEmit` for types. Keep the esbuild bundle free of `@kubernetes/client-node`.
- Live local verification (when touching the compute plane): `make up`, then the scripts in
  `infra/local/` (`verify-isolation.sh`, `verify-edge-dispatch.sh`).

## Two local compute paths

| | `make up` / `cluster-up.sh` | `make compute-up` / `compute-up.sh` |
| - | --------------------------- | ----------------------------------- |
| k3s via | a privileged **container** | **Floci's `aws eks`** (nests k3s via the Docker socket) |
| Engines | any (podman/docker/rancher/colima) | **Docker only** (Floci refuses podman) |
| Use for | day-to-day dev | AWS-faithful checks (real `aws eks`/ECR/RDS/IAM emulation) |

See [ADR-0001](decisions/0001-engine-agnostic-local-compute.md).

## Gotchas (hard-won)

- The podman VM must be **rootful** and adequately sized, and k3s needs a **stable node IP**
  ([ADR-0002](decisions/0002-podman-vm-requirements.md), [ADR-0003](decisions/0003-down-up-preserve-cluster.md)).
- Behind a proxy, in-cluster image pulls fail `x509` unless k3s trusts the corp CA
  ([ADR-0010](decisions/0010-corp-ca-handling.md)).
- `make down` **preserves** the cluster (stop/start); use `make nuke` to actually wipe it.
- `zsh` does not word-split unquoted vars — pass env to child processes explicitly, not via an
  unquoted `$VARSTRING`.

## Conventions

Match surrounding code. Work on a branch. Never commit secrets. End commit messages with
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. The user opens PRs. Redact the
token embedded in the git remote URL from any output.
