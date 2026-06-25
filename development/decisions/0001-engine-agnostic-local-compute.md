# 0001 — Local compute = k3s-in-a-container (engine-agnostic), not Floci-EKS

Status: Accepted

## Context

We need a local copy of the prod compute plane (Kubernetes + KEDA + CloudNativePG). The original
local stack, `infra/local/compute-up.sh`, uses **Floci** (an AWS emulator) whose `aws eks
create-cluster` nests a real k3s **via the Docker socket**. Floci ignores `DOCKER_HOST` and drives
the socket directly, so it **only works on a real Docker daemon and refuses podman** — but this
repo's default local engine is podman, and contributors variously use Docker Desktop, Rancher
Desktop, or colima.

## Decision

Add a second, lightweight path (`infra/local/cluster-up.sh`, wired to `make up`/`make cluster-up`)
that runs **k3s directly as a privileged container** and installs the Drop operators into it.
Because nothing drives the Docker socket, it is **engine-agnostic**: it works on podman, Docker
Desktop, Rancher Desktop (dockerd engine), and colima. The engine is auto-detected and overridable
via `DROP_CONTAINER_ENGINE` / `make CE=docker`.

`compute-up.sh` (Floci-EKS) is kept for **AWS-faithful** checks (real `aws eks` + ECR + RDS + IAM +
Secrets emulation), and remains Docker-only.

The Drop API is engine- and path-agnostic: it just needs `DROP_KUBECONFIG` pointing at a cluster.

## Consequences

- Day-to-day local dev no longer requires Docker; `make up` is the default.
- The podman restriction was never about k3s or Drop — only about Floci's nesting mechanism.
- Two code paths to keep working; the lighter one is primary. Operator versions are pinned in
  `cluster-up.sh` for reproducibility.
