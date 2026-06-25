# 0003 — `down`/`up` preserve the cluster (stop/start) via a stable node IP

Status: Accepted

## Context

Originally `make down` removed the k3s container. Since the cluster (k3s + KEDA + CNPG + deployed
apps + imported images) lives only inside that container, every `make up` rebuilt from scratch and
reinstalled all operators (~3 min, and needed the corp CA again). That's painful for iterative dev.

A naive "just stop/start the container" crashes k3s: a restarted container gets a **new IP**, but
k3s persisted the old node IP → `failed to start networking: ... failed to find interface with
specified node ip`.

## Decision

Make `down`/`up` **suspend/resume**:

- `cluster-down.sh` **stops** the k3s container by default (state preserved); `DROP_WIPE=1` removes
  it. `make down` = stop; `make nuke` = wipe.
- `cluster-up.sh` reuses a running container, **restarts a stopped one**, else creates fresh. The
  operator install is idempotent, so resume is a fast no-op.
- For resume to work, k3s runs on a dedicated podman network with a **fixed `--ip` plus matching
  `--node-ip`** (`DROP_K3S_NET`/`IP`/`SUBNET`, default `drop-net` / `10.89.0.2` / `10.89.0.0/24`).

## Consequences

- `make down` → `make up` resumes in ~tens of seconds with no operator reinstall and no CA needed
  (images are cached in the stopped container). Verified end-to-end.
- A stopped container holds disk in the VM until `make nuke`.
- Mirrors how Floci/Postgres already behave (stop preserves; `make reset` wipes their volumes).
