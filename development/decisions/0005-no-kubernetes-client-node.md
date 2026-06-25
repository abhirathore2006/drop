# 0005 — Talk to Kubernetes via a raw client, not `@kubernetes/client-node`

Status: Accepted

## Context

The compute plane needs to create/patch Kubernetes objects (namespaces, Deployments, Services,
Secrets, NetworkPolicies, KEDA `HTTPScaledObject`s, CNPG `Cluster`s, ESO `ExternalSecret`s).
`@kubernetes/client-node` is the obvious library, but it's large, drags in many transitive deps,
and complicates the esbuild bundle (and the single-file `dist/*.js` artifacts the image ships).

## Decision

Implement `src/kube/KubeApiClient` directly on `node:https` using **server-side apply** (SSA). It
supports both auth modes: a kubeconfig file, and **in-cluster** ServiceAccount auth
(`inClusterConn()` reads the SA token/CA when `DROP_KUBECONFIG=in-cluster`). The bundle stays free
of `@kubernetes/client-node`.

Unit tests use `FakeKube` (an in-memory double) injected via `createApp(Deps)`, so no real cluster
is needed.

## Consequences

- Small, dependency-light bundle; fast cold start.
- We own a thin slice of Kubernetes API plumbing (SSA, status checks, a CRD-present preflight). New
  resource kinds are added explicitly — that's intentional and keeps the surface auditable.
- RBAC for the API ServiceAccount (in `infra/helm/drop/templates/rbac.yaml`) must mirror exactly
  what `KubeApiClient` touches.
