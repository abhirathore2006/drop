# 0004 — Install the databases plane by default; ESO only for the aws backend

Status: Accepted

## Context

`cluster-up` originally installed only the **apps** plane (KEDA + HTTP add-on + gvisor) by default;
databases (CloudNativePG) were behind `DROP_COMPUTE_FULL=1`. So a plain `make up` left
`drop db create` returning `500: postgresql.cnpg.io CRD not installed` — a surprising wall for
anyone exercising the platform.

Separately, External Secrets Operator (ESO) is only needed for the **`aws`** secret backend; the
default `kube` backend (plain Kubernetes Secrets) needs no ESO, so installing it always was waste.

## Decision

- Install the **databases plane** (cert-manager + CloudNativePG + Barman Cloud Plugin) **by
  default** in `cluster-up`. Opt out with `DROP_APPS_ONLY=1` for a lighter/faster cluster.
- Install **ESO** only when it's actually used: `DROP_SECRET_BACKEND=aws` (or `DROP_ESO=1`, or the
  legacy `DROP_COMPUTE_FULL=1`).

This is affordable because [ADR-0003](0003-down-up-preserve-cluster.md) made the cluster persist:
the heavier install is a one-time cost; later `make up`s are fast restarts that keep it.

## Consequences

- `drop db create` works out of the box after `make up`.
- The error hint when a CRD is missing now points at `make up` / `make cluster-up`, not the
  Docker-only `make compute-up`.
- `cert-manager` is installed because the Barman Cloud Plugin requires it (issues its gRPC TLS
  certs).
