# 0002 — The podman VM must be rootful + sized (cpuset)

Status: Accepted

## Context

A *fresh* podman machine (podman 5.x / machine-os 5.8) defaults to **rootless** and a small VM.
Running k3s-in-a-container on it fails in two ways that a long-lived dev VM had silently worked
around:

- **Rootless** → containers run in a user namespace → kubelet dies
  `open /dev/kmsg: operation not permitted`, and the `cpuset` cgroup controller isn't delegated
  (`failed to find cpuset cgroup (v2)`).
- **Undersized** → scale-to-zero / operator pods stay `Pending` (Insufficient memory).

These only surface on a clean machine, so they were easy to miss until a full teardown+rebuild.

## Decision

`make setup` provisions a **rootful**, sized VM (`podman machine init --rootful --cpus 6 --memory
8192 --disk-size 100`, overridable via `VM_CPUS`/`VM_MEMORY`/`VM_DISK`), and switches an existing
VM to rootful if needed. `cluster-up.sh` also flips the machine to rootful before starting k3s.
Rootful containers run as real root (no userns), which gives kubelet `/dev/kmsg` and makes `cpuset`
available — so no cgroup-delegation drop-in is required.

## Consequences

- A fresh machine is compute-ready from `make setup` alone, no manual steps.
- `make doctor` checks rootful + memory and fails with a clear fix if they're wrong.
- Docker/Rancher Desktop are daemon-managed (no `podman machine`); the Makefile branches on engine.
