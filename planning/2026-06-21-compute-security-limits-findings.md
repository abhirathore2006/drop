# Compute Platform — Security & Resource-Limits Findings

**Date:** 2026-06-21
**Method:** live testing against the real stack — k3s (on rootful podman) + KEDA + the Drop API wired via `KubeClient`. Probes deployed through the platform (`drop deploy`) and inspected with `kubectl`/in-pod `exec`. Evidence is reproduced inline.

---

## Summary

Resource limits **work and are kernel-enforced when specified** (cgroup CPU throttle + memory OOM-kill verified). The platform also gets several things right (the deploy surface can't request privilege; the default ServiceAccount is not over-privileged). The gaps are exactly the **multi-tenancy isolation layer** the v2 analysis flagged as the gating P1 — now confirmed with concrete evidence: no NetworkPolicy, no ResourceQuota/LimitRange, no default resource limits, single shared namespace, no runtime sandbox / non-root enforcement.

---

## What's solid (verified positives)

| ID | Finding | Evidence |
|----|---------|----------|
| **SEC-P1** | Default ServiceAccount is **not** over-privileged | `can-i --list` for `system:serviceaccount:drop-apps:default` = only self-subject-reviews + `/api` discovery; in-pod token → list secrets = **HTTP 403** |
| **SEC-P2** | Tenants **cannot** request privilege via the platform | AppConfig surface is only `image/resources/env/services/scale` — no `privileged`/`hostPath`/`securityContext`/`volumes` |
| **SEC-P3** | Baseline hardening on every app container | `allowPrivilegeEscalation:false` + `seccompProfile:RuntimeDefault` applied |
| **LIM-P1** | CPU + memory limits are **kernel-enforced** (cgroups) | `cpu.max = 50000 100000` (=0.5 core); under a 4-core burn → `nr_throttled 50`; mem bomb past 64Mi → `reason: OOMKilled`, exitCode 137, container restarted |

---

## Security findings

| ID | Sev | Finding | Evidence | Remediation |
|----|-----|---------|----------|-------------|
| **SEC-1** | **High** | **No NetworkPolicy** — unrestricted pod ingress/egress. Cross-app traffic flows freely; pods can reach the cluster API. In a real VPC an app could reach the control-plane RDS/S3. | `kubectl get networkpolicy -n drop-apps` = **0**; `curltest → whoami` = **200** (cross-app); `pod → kubernetes.default` reachable (TLS 401, i.e. network-open) | default-deny `NetworkPolicy` per tenant namespace (+ DNS/egress allowlist); block egress to the control-plane subnets |
| **SEC-2** | **High** | **No runtime sandbox** for arbitrary images — they share the node kernel. Container escape → host/other tenants. | `runtimeClassName` on app pods = **none**; app kernel == node kernel (`6.19.7…`) | gVisor/Kata `RuntimeClass` for untrusted images; "internal-trusted images" first |
| **SEC-3** | **Medium** | **No `runAsNonRoot` / `readOnlyRootFilesystem`** — apps run as **root** with a writable rootfs. | pod `securityContext` = `{}`; container sets only `allowPrivilegeEscalation:false` + seccomp; nginx ran as root (chown to uid 101 in entrypoint) | Pod Security Admission `restricted`; enforce non-root where the image allows |
| **SEC-4** | **Medium** | **Single shared namespace** (`drop-apps`) for all apps → no tenant boundary; compounds SEC-1/LIM-2. | both apps in `drop-apps`; `APP_NAMESPACE = "drop-apps"` constant | namespace-per-tenant (already the analysis recommendation) |
| **SEC-5** | **Low–Med** | **App env in the pod spec (plaintext)**, not a `Secret` — readable by anyone with pod-read in the namespace. | env passed as container `env:` literals by the translator | put env (esp. credentials) in k8s `Secret`s; reference via `secretKeyRef` |

> Note: a direct pod→public-internet probe returned `000` (inconclusive — likely the podman-VM egress/Zscaler, not a k8s control). The cross-pod and pod→API reachability above are the load-bearing evidence that **no network isolation exists**.

## Resource-limits findings

| ID | Sev | Finding | Evidence | Remediation |
|----|-----|---------|----------|-------------|
| **LIM-1** | **High** | **No default limits** — an app deployed without a `resources:` block runs **unbounded**. A tenant who omits limits is an unconstrained noisy neighbor. | `web-nginx` (no `resources` in drop.yaml) → `spec…resources = {}` | inject defaults (translator) and/or a namespace `LimitRange` with default + defaultRequest |
| **LIM-2** | **High** | **No ResourceQuota** per namespace — total CPU/mem and object counts a tenant can consume are uncapped. | `kubectl get resourcequota -n drop-apps` = **0** | `ResourceQuota` per tenant namespace (cpu/mem/pods/services) |
| **LIM-3** | **Medium** | `maxReplicaCount` caps a single app's replicas, but nothing caps **how many apps** / total footprint a tenant deploys. | HSO max enforced per-app; no aggregate cap | quota (LIM-2) + per-tenant app-count limits |

---

## Bottom line

The compute core (deploy → cgroup-limited, scale-to-zero workloads) is sound, and per-workload limits are real. **Every gap here is the tenancy/isolation layer** — `namespace-per-tenant + NetworkPolicy + ResourceQuota + LimitRange + PSA/runAsNonRoot + a sandbox RuntimeClass`. This validates the v2 analysis's call to make tenancy a **P1, not P4**, item, and to launch **internal-trusted images first** before opening to arbitrary multi-tenant workloads. None of these are blockers for an internal-trusted v1; all are required before untrusted multi-tenancy.
