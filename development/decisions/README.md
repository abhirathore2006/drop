# Decision records (ADRs)

Short records of significant engineering/architecture decisions and *why* they were made. Read the
relevant one before changing that area; add a new record when you make a decision worth remembering.

**Format:** Context → Decision → Consequences. Status is `Accepted` unless noted. Keep them short.

| # | Decision | Status |
| - | -------- | ------ |
| [0001](0001-engine-agnostic-local-compute.md) | Local compute = k3s-in-a-container (engine-agnostic), not Floci-EKS | Accepted |
| [0002](0002-podman-vm-requirements.md) | The podman VM must be rootful + sized; cpuset delegation | Accepted |
| [0003](0003-down-up-preserve-cluster.md) | `down`/`up` preserve the cluster (stop/start) via a stable node IP | Accepted |
| [0004](0004-databases-plane-default.md) | Install the databases plane by default; ESO only for the aws backend | Accepted |
| [0005](0005-no-kubernetes-client-node.md) | Talk to Kubernetes via a raw client, not `@kubernetes/client-node` | Accepted |
| [0006](0006-ports-and-factories.md) | Pluggable `SecretStore` / `ImageStore` ports chosen by a factory | Accepted |
| [0007](0007-static-vs-compute-modes.md) | Static-only vs compute is opt-in (`DROP_KUBECONFIG`); ECS static, EKS both | Accepted |
| [0008](0008-drop-yaml-config.md) | `drop.yaml` is the only site/app config (`_drop.json` removed) | Accepted |
| [0009](0009-versioning-and-installer.md) | Build-time CLI version + self-updating served `install.sh` | Accepted |
| [0010](0010-corp-ca-handling.md) | Corp CA: record at setup, auto-mount into k3s, fast-fail on x509 | Accepted |
