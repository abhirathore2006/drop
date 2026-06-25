# 0007 — Static-only vs compute is opt-in (`DROP_KUBECONFIG`); ECS static, EKS both

Status: Accepted

## Context

Not every deployment wants (or can run) Kubernetes. The static-site host is useful on its own and
much cheaper/simpler. But the same product also offers the compute PaaS. We needed a single
codebase that degrades cleanly.

## Decision

Compute is **opt-in at runtime**: the API enables apps/databases/secrets only when it has a cluster
(`DROP_KUBECONFIG` set, including `in-cluster`). Without it, the platform is **static-only** and
`/v1/apps`, `/v1/databases` and the secret routes return **`501`** rather than erroring obscurely.

Deployment targets map onto this:

- **ECS / Fargate** (and plain EC2) — always **static-only** (no Kubernetes).
- **EKS** — static-only by default; **compute** when `compute_enabled = true` (Helm
  `compute.enabled`, which sets `DROP_KUBECONFIG=in-cluster` and grants the API RBAC).

## Consequences

- One image, one codebase, two coherent product tiers.
- Docs and Terraform are written to make the static-vs-compute distinction explicit (see
  `docs/aws-deployment.html`, `docs/terraform.html`, `infra/terraform/README.md`).
- A `501` is a deliberate "not enabled here" signal, not a bug.
