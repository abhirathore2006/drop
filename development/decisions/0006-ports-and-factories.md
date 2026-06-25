# 0006 — Pluggable `SecretStore` / `ImageStore` ports chosen by a factory

Status: Accepted

## Context

App **secrets** and tenant **images** must work differently locally vs in prod:

- Secrets: plain Kubernetes Secrets (simple, no deps) vs AWS Secrets Manager synced by External
  Secrets Operator.
- Images: import a `docker save` tarball into the local k3s node's containerd vs push to a registry
  (ECR) in prod.

We don't want `if (local) … else …` scattered through the API.

## Decision

Define **ports** (interfaces) with multiple backends, selected by a **factory from env at deploy
time**:

- `SecretStore` → `kube` (Kubernetes Secrets) | `aws` (Secrets Manager via ESO), per
  `DROP_SECRET_BACKEND`.
- `ImageStore` → `containerd` (local, `<engine> exec <k3s> ctr images import`) | `registry` (ECR) |
  `noop`, per `DROP_IMAGE_BACKEND`.

The same application code runs in both environments; only the wiring differs. Tests inject
`FakeSecretStore` / `FakeImageStore`.

## Consequences

- Local and prod exercise the *same* code paths (e.g. the `aws` secret backend runs against Floci's
  Secrets-Manager emulation locally).
- Adding an environment = adding a backend + a factory branch, not editing call sites.
- The local containerd backend needs the k3s container name to match `DROP_K3S_CONTAINER` (default
  `k3s`) — `cluster-up.sh` names the container accordingly.
