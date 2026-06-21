# Compute Platform — Hardening & Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate every security & resource-limits finding from `2026-06-21-compute-security-limits-findings.md` and complete the unfinished original requirements (apps serve through the Drop edge; managed databases), without regressing scale-to-zero, kernel-enforced limits, arbitrary images, ECR, or `drop.yaml`.

**Architecture:** Each workload runs in a **per-tenant namespace** that the API provisions on first deploy, carrying a default-deny `NetworkPolicy`, a `ResourceQuota`, a `LimitRange`, and Pod Security Admission labels. The manifest translator emits these tenant objects plus per-workload objects (Deployment + Service + KEDA `HTTPScaledObject` + a `Secret` for env), injecting default resource limits when the user omits them. Untrusted images run under a sandbox `RuntimeClass` (gVisor). Databases are CloudNativePG `Cluster`s with persistent storage, S3 backups, and **scheduled** hibernation (request-triggered DB wake is infeasible — KEDA-HTTP can't wake the Postgres TCP protocol — so this delivers the cost intent within what's achievable).

**Tech Stack:** TypeScript on Node 24, Hono, Kysely + Postgres, esbuild bundle, `bun test`; Kubernetes (k3s locally via Floci on podman / EKS in prod), KEDA + KEDA HTTP add-on, CloudNativePG, gVisor. No new heavy app deps — the `KubeClient` stays `node:https` + the bundled `yaml`.

## Global Constraints

- **443-only v1:** an app exposes exactly one HTTP service (`assertHttpOnly`); raw-TCP/multi-port deferred.
- **Self-contained bundle:** no `@kubernetes/client-node` — the `KubeClient` is `node:https` + server-side apply.
- **Compute is opt-in:** no `DROP_KUBECONFIG` → `/v1/apps` & `/v1/databases` return 501.
- **Reproducible locally:** every cluster object is verifiable on the Floci/k3s stack (`make compute-up`), the same methodology used to find the issues.
- **Internal-trusted-images first:** the sandbox `RuntimeClass` is *available* and used for untrusted tenants; do not block v1 on it.
- **Tenant = workload owner** (email) for v1: namespace `drop-t-<slug(email)>`. (A `tenants` mapping table is a later option; per-owner is the safe default.)

## File Structure

- `src/api/tenant.ts` — **create.** `tenantSlug(email)` and `tenantNamespace(email)` — deterministic, DNS-safe namespace per owner. One responsibility: tenant→namespace identity.
- `src/kube/manifests.ts` — **modify.** Add `tenantManifests(namespace)` (Namespace+NetworkPolicy+ResourceQuota+LimitRange) and extend `appManifests` (env `Secret` + `envFrom`, default limits, optional `runtimeClassName`). Keep it the single source of K8s object shapes.
- `src/kube/types.ts` — **modify.** `KubeClient` gains `applyTenant(namespace, manifests)`.
- `src/kube/fake.ts` — **modify.** `FakeKube.applyTenant` records tenant applies.
- `src/kube/client.ts` — **modify.** Implement `applyTenant` (server-side apply each tenant object).
- `src/app-config.ts` — **modify.** `DEFAULT_RESOURCES`; `sanitizeAppConfig` fills `resources` when omitted. Add `trusted?: boolean` (default false → sandboxed).
- `src/api/server.ts` — **modify.** Deploy endpoint: resolve tenant ns, `ensureTenant`, apply app into it, env→Secret. Add the `/v1/databases` endpoints (Phase C).
- `src/kube/cnpg.ts` — **create (Phase C).** CNPG `Cluster` + `ScheduledBackup` manifest builder.
- `src/db-config.ts` — **create (Phase C).** Parse the `database:` section of `drop.yaml`.
- `src/cli/commands.ts`, `src/cli/client.ts`, `src/mcp/server.ts` — **modify (Phase C).** `drop db:create` / `db:proxy`.
- `src/edge/server.ts` — **modify (Phase B).** Dispatch `type=app` hostnames → proxy to the in-cluster KEDA interceptor.
- `infra/local/compute-up.sh` — **modify.** Install the gVisor `RuntimeClass`; CNPG already installed.

---

## Phase A — Tenancy & isolation (fixes SEC-1…5, LIM-1…3)

### Task A1: Tenant → namespace identity (SEC-4)

**Files:** Create `src/api/tenant.ts`; Test `src/api/tenant.test.ts`

**Interfaces:**
- Produces: `tenantNamespace(email: string): string` — DNS-1123 label, ≤ 63 chars, deterministic.

- [ ] **Step 1: Write the failing test** — `src/api/tenant.test.ts`:

```ts
import { test, expect } from "bun:test";
import { tenantNamespace } from "./tenant.ts";

test("tenantNamespace is deterministic, DNS-safe, prefixed, and stable", () => {
  const ns = tenantNamespace("Alice.Smith@example.com");
  expect(ns).toMatch(/^drop-t-[a-z0-9-]{1,55}$/);
  expect(ns).toBe(tenantNamespace("Alice.Smith@example.com")); // stable
  expect(ns).not.toBe(tenantNamespace("bob@example.com")); // distinct tenants
});

test("tenantNamespace stays within the 63-char k8s label limit for long emails", () => {
  expect(tenantNamespace("a".repeat(200) + "@example.com").length).toBeLessThanOrEqual(63);
});
```

- [ ] **Step 2: Run** `bun test src/api/tenant.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/api/tenant.ts`:

```ts
import { createHash } from "node:crypto";

/** Per-tenant namespace for a workload owner. Deterministic + DNS-1123-safe.
 *  v1 tenant == owner email; a long/odd email is slugged with a hash suffix. */
export function tenantNamespace(email: string): string {
  const base = email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const h = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 8);
  return `drop-t-${base}-${h}`.slice(0, 63).replace(/-+$/g, "");
}
```

- [ ] **Step 4: Run** `bun test src/api/tenant.test.ts` → PASS.

- [ ] **Step 5: Commit** `git add src/api/tenant.ts src/api/tenant.test.ts && git commit -m "feat(tenant): per-owner namespace identity (SEC-4)"`

---

### Task A2: Tenant manifests — Namespace + NetworkPolicy + ResourceQuota + LimitRange (SEC-1, SEC-4, LIM-1, LIM-2)

**Files:** Modify `src/kube/manifests.ts`; Test `src/kube/manifests.test.ts`

**Interfaces:**
- Produces: `tenantManifests(namespace: string): { namespace; networkPolicy; resourceQuota; limitRange }` — plain K8s objects. The `Namespace` carries PSA labels (`pod-security.kubernetes.io/enforce: baseline`, `warn/audit: restricted`). The default-deny `NetworkPolicy` denies all ingress + all egress except DNS and intra-namespace; explicitly **no** egress to the control-plane CIDR.

- [ ] **Step 1: Write the failing test** — append to `src/kube/manifests.test.ts`:

```ts
import { tenantManifests } from "./manifests.ts";

test("tenantManifests: PSA-labeled namespace + default-deny NetworkPolicy + quota + limitrange", () => {
  const m = tenantManifests("drop-t-alice-1234");
  expect((m.namespace as any).metadata.labels["pod-security.kubernetes.io/enforce"]).toBe("baseline");
  const np = m.networkPolicy as any;
  expect(np.spec.policyTypes).toEqual(["Ingress", "Egress"]);
  // egress allows DNS (UDP/TCP 53) + intra-namespace, nothing else by default
  const dns = np.spec.egress.some((e: any) => (e.ports ?? []).some((p: any) => p.port === 53));
  expect(dns).toBe(true);
  expect((m.resourceQuota as any).spec.hard["limits.cpu"]).toBeDefined();
  expect((m.resourceQuota as any).spec.hard["count/pods"]).toBeDefined();
  expect((m.limitRange as any).spec.limits[0].default.cpu).toBeDefined();
});
```

- [ ] **Step 2: Run** `bun test src/kube/manifests.test.ts` → FAIL.

- [ ] **Step 3: Implement** — add to `src/kube/manifests.ts`:

```ts
export interface TenantManifests {
  namespace: Record<string, unknown>;
  networkPolicy: Record<string, unknown>;
  resourceQuota: Record<string, unknown>;
  limitRange: Record<string, unknown>;
}

// Per-tenant defaults. Tune via config later; conservative caps for v1.
const QUOTA = { "limits.cpu": "4", "limits.memory": "8Gi", "count/pods": "20", "count/services": "10" };
const LIMITRANGE_DEFAULT = { cpu: "0.5", memory: "512Mi" };
const LIMITRANGE_DEFAULT_REQUEST = { cpu: "100m", memory: "128Mi" };

export function tenantManifests(namespace: string): TenantManifests {
  const labels = {
    "app.kubernetes.io/managed-by": "drop",
    "pod-security.kubernetes.io/enforce": "baseline",
    "pod-security.kubernetes.io/warn": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
  };
  return {
    namespace: { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels } },
    // default-deny everything, then allow DNS egress + intra-namespace both ways.
    // The KEDA interceptor reaches the app via an explicit allow added per-app (A4).
    networkPolicy: {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "drop-default-deny", namespace },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [{ from: [{ podSelector: {} }] }], // intra-namespace ingress
        egress: [
          { to: [{ podSelector: {} }] }, // intra-namespace egress
          {
            // DNS to kube-dns
            to: [{ namespaceSelector: {} }],
            ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
          },
        ],
      },
    },
    resourceQuota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "drop-quota", namespace },
      spec: { hard: QUOTA },
    },
    limitRange: {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: "drop-defaults", namespace },
      spec: { limits: [{ type: "Container", default: LIMITRANGE_DEFAULT, defaultRequest: LIMITRANGE_DEFAULT_REQUEST }] },
    },
  };
}
```

- [ ] **Step 4: Run** `bun test src/kube/manifests.test.ts` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(kube): per-tenant NetworkPolicy + ResourceQuota + LimitRange + PSA (SEC-1/4, LIM-1/2)"`

---

### Task A3: Default resource limits in the app config (LIM-1 belt-and-suspenders)

**Files:** Modify `src/app-config.ts`; Test `src/app-config.test.ts`

**Interfaces:** Consumes nothing new. `sanitizeAppConfig` now always returns `resources` (defaulted) so the translator never emits a limitless container even if the namespace LimitRange is missing.

- [ ] **Step 1: Write the failing test** — append to `src/app-config.test.ts`:

```ts
test("sanitizeAppConfig defaults resources when omitted (no unbounded containers)", () => {
  const c = sanitizeAppConfig({ image: "x:1" })!;
  expect(c.resources).toEqual({ cpu: "0.5", memory: "512Mi" });
});
```

- [ ] **Step 2: Run** `bun test src/app-config.test.ts` → FAIL (resources undefined).

- [ ] **Step 3: Implement** — in `src/app-config.ts`, add `const DEFAULT_RESOURCES = { cpu: "0.5", memory: "512Mi" };` and after the existing `resources` parsing add: `if (!cfg.resources) cfg.resources = { ...DEFAULT_RESOURCES };`

- [ ] **Step 4: Run** `bun test src/app-config.test.ts` → PASS. Also `bun test src/kube/manifests.test.ts` (translator now always sets limits) → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(app-config): default resource limits so apps are never unbounded (LIM-1)"`

---

### Task A4: App manifests — env Secret + per-app interceptor ingress + sandbox RuntimeClass (SEC-5, SEC-2, SEC-1)

**Files:** Modify `src/kube/manifests.ts`; Test `src/kube/manifests.test.ts`

**Interfaces:**
- `appManifests(app, ctx)` now also returns `secret` (env as a K8s `Secret`) and an `ingressPolicy` (NetworkPolicy allowing the KEDA interceptor namespace to reach this app's pods on the service port). The Deployment uses `envFrom: [{ secretRef }]` instead of inline `env`. When `ctx.sandbox` is true, the pod gets `runtimeClassName: "gvisor"`.
- `AppManifests` gains `secret`, `ingressPolicy`; `ManifestContext` gains `sandbox?: boolean`.

- [ ] **Step 1: Write the failing test** — append to `src/kube/manifests.test.ts`:

```ts
test("appManifests: env goes into a Secret (not inline); interceptor ingress allowed; sandbox optional", () => {
  const m = appManifests(
    { image: "x:1", env: { TOKEN: "s3cr3t" }, services: [{ internalPort: 8080, protocol: "http" }] },
    { name: "billing", namespace: "drop-t-alice", host: "billing.drop.example.com", sandbox: true },
  );
  // env is in a Secret, referenced via envFrom — not plaintext in the pod spec
  expect((m.secret as any).kind).toBe("Secret");
  expect((m.secret as any).stringData.TOKEN).toBe("s3cr3t");
  const ctr = (m.deployment as any).spec.template.spec.containers[0];
  expect(ctr.env).toBeUndefined();
  expect(ctr.envFrom[0].secretRef.name).toBe("billing-env");
  expect((m.deployment as any).spec.template.spec.runtimeClassName).toBe("gvisor");
  // an ingress NetworkPolicy lets the KEDA interceptor reach this app
  expect((m.ingressPolicy as any).kind).toBe("NetworkPolicy");
  expect(JSON.stringify(m.ingressPolicy)).toContain("keda");
});

test("appManifests: no runtimeClassName when sandbox is false/omitted (internal-trusted)", () => {
  const m = appManifests({ image: "x:1", services: [{ internalPort: 80, protocol: "http" }] }, { name: "a", namespace: "n", host: "a.x" });
  expect((m.deployment as any).spec.template.spec.runtimeClassName).toBeUndefined();
});
```

- [ ] **Step 2: Run** `bun test src/kube/manifests.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/kube/manifests.ts`: extend `ManifestContext` with `sandbox?: boolean`; extend `AppManifests` with `secret` and `ingressPolicy`. In `appManifests`: build `secret = { apiVersion:"v1", kind:"Secret", metadata:{name:`${ctx.name}-env`,namespace}, stringData: app.env ?? {} }`; replace the container `env` with `envFrom: [{ secretRef: { name: `${ctx.name}-env` } }]` (omit `envFrom` if no env); add `...(ctx.sandbox ? { runtimeClassName: "gvisor" } : {})` to the pod spec; add `ingressPolicy` (NetworkPolicy `name: `${ctx.name}-allow-interceptor`` selecting the app pods, allowing ingress from the `keda` namespace on the container port). Show the full edited `appManifests` body in the implementation.

- [ ] **Step 4: Run** `bun test src/kube/manifests.test.ts` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(kube): env via Secret, per-app interceptor ingress, optional gvisor sandbox (SEC-5/2/1)"`

---

### Task A5: KubeClient.applyTenant + FakeKube (apply the tenant objects)

**Files:** Modify `src/kube/types.ts`, `src/kube/fake.ts`, `src/kube/client.ts`, `src/kube/fake.test.ts`

**Interfaces:**
- `KubeClient.applyTenant(namespace: string, t: TenantManifests): Promise<void>` — server-side apply Namespace, then NetworkPolicy/ResourceQuota/LimitRange.
- `applyApp` also applies `secret` + `ingressPolicy`.

- [ ] **Step 1: Write the failing test** — `src/kube/fake.test.ts`: assert `FakeKube.applyTenant` records the 4 objects and `applyApp` records `secret`+`ingressPolicy`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `types.ts`: add `applyTenant`. `fake.ts`: record `tenantApplies`. `client.ts`: `applyTenant` SSA-applies each via the existing `apply()` (Namespace at `/api/v1/namespaces/<ns>`, NetworkPolicy at `/apis/networking.k8s.io/v1/namespaces/<ns>/networkpolicies/<name>`, ResourceQuota at `/api/v1/namespaces/<ns>/resourcequotas/<name>`, LimitRange at `/api/v1/namespaces/<ns>/limitranges/<name>`); extend `applyApp` to also apply Secret (`/api/v1/namespaces/<ns>/secrets/<name>`) and the ingress NetworkPolicy.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(kube): KubeClient.applyTenant + apply env Secret/ingress policy"`

---

### Task A6: Wire the deploy endpoint to provision the tenant namespace (SEC-1/4/5, LIM-1/2)

**Files:** Modify `src/api/server.ts`; Test `src/api/server.test.ts`

**Interfaces:** Consumes `tenantNamespace`, `tenantManifests`, the extended `appManifests`/`applyApp`/`applyTenant`. The deploy endpoint now: resolve `ns = tenantNamespace(site.owner)`; `kube.applyTenant(ns, tenantManifests(ns))`; `kube.applyApp(ns, name, appManifests(appCfg, { name, namespace: ns, host, sandbox: !appCfg.trusted }))`.

- [ ] **Step 1: Write the failing test** — append to `src/api/server.test.ts`:

```ts
test("deploy provisions a per-owner tenant namespace with isolation objects", async () => {
  const { app, kube, db } = await mk();
  await call(app, "POST", "/v1/apps/billing", "alice", { image: "x:1", env: { K: "v" } });
  const ns = kube.tenantApplies[0]!.namespace;
  expect(ns).toMatch(/^drop-t-/);                                  // per-owner ns
  expect(kube.applies[0]!.namespace).toBe(ns);                     // app applied into it
  const t = kube.tenantApplies[0]!.manifests;
  expect((t.resourceQuota as any).spec.hard["count/pods"]).toBeDefined();
  expect((kube.applies[0]!.manifests.secret as any).stringData.K).toBe("v"); // env in Secret
  await db.destroy();
});
```

- [ ] **Step 2: Run** `bun test src/api/server.test.ts` → FAIL (uses old single `APP_NAMESPACE`).

- [ ] **Step 3: Implement** — replace the `APP_NAMESPACE` constant usage in the deploy endpoint with `const ns = tenantNamespace(site.owner)`, call `await d.kube.applyTenant(ns, tenantManifests(ns))` before `applyApp`, pass `namespace: ns` + `sandbox: !appCfg.trusted` into `appManifests`. Import `tenantNamespace` + `tenantManifests`.

- [ ] **Step 4: Run** full suite `bun test` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(api): deploy into a provisioned per-tenant namespace (SEC-1/4/5, LIM-1/2)"`

---

### Task A7: gVisor RuntimeClass in the local cluster + live isolation verification

**Files:** Modify `infra/local/compute-up.sh`; Create `infra/local/verify-isolation.sh`

**Interfaces:** none (infra + verification).

- [ ] **Step 1:** In `compute-up.sh`, after the cluster is up, install the gVisor `RuntimeClass` (containerd `runsc`) — for k3s, deploy the gVisor installer DaemonSet + a `RuntimeClass` named `gvisor`; document that EKS uses Bottlerocket/sandboxed-containers. (k3s note: if `runsc` isn't available on the node, mark sandbox best-effort and keep PSA+NetworkPolicy as the guard.)

- [ ] **Step 2:** Create `infra/local/verify-isolation.sh` that reproduces the finding probes and asserts they now PASS: (a) deploy two apps under different owners → different namespaces; (b) `kubectl get networkpolicy,resourcequota,limitrange -n <ns>` non-empty; (c) a probe pod in tenant A **cannot** curl tenant B's service (cross-namespace blocked) — expect timeout; (d) an app without `resources:` now has limits from the LimitRange; (e) env is in a Secret, not the pod spec.

- [ ] **Step 3: Run** `make compute-up && ./infra/local/verify-isolation.sh` → all assertions PASS (cross-tenant blocked, quota/limits present, env in Secret).

- [ ] **Step 4: Commit** `git commit -am "feat(local): gvisor RuntimeClass + isolation verification script"`

---

## Phase B — Apps serve through the Drop edge (original requirement: apps get DNS like sites)

### Task B1: Edge dispatch — `type=app` hostnames proxy to the KEDA interceptor

**Files:** Modify `src/edge/server.ts`; Test `src/edge/server.test.ts`

**Interfaces:** The edge already reads `getPointer(name)` which now returns `type`. For `type==="app"`, instead of serving S3 bytes, reverse-proxy the request to the in-cluster KEDA HTTP interceptor (`http://<interceptor-host>:8080/`) preserving the original `Host` header (so KEDA routes by host and wakes the pod). Interceptor URL from config `DROP_INTERCEPTOR_URL`.

- [ ] **Step 1: Write the failing test** — `src/edge/server.test.ts`: with a fake fetch + a pointer `{type:"app"}`, a request to `app.drop.example.com/x` proxies to the interceptor with the original Host and returns its response; a `{type:"site"}` pointer still serves S3 (unchanged).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — in `src/edge/server.ts`, after resolving the pointer, branch on `type`: `app` → build a `fetch` to `${cfg.interceptorUrl}${path}` with headers incl. `host` preserved + `X-Forwarded-*`, return the upstream response; `site` → existing S3 path. Inject `interceptorUrl` via `EdgeDeps`.

- [ ] **Step 4: Run** `bun test src/edge/server.test.ts` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(edge): dispatch app hostnames to the KEDA interceptor (apps serve like sites)"`

### Task B2: Live edge→interceptor→app verification

- [ ] **Step 1:** On the local stack, point the edge at the interceptor (`kubectl port-forward` the interceptor or a NodePort), deploy an app, `curl -H 'Host: <app>.drop.localhost' http://localhost:8474/` → 200 from the app (waking it from zero). Document in `infra/local/verify-isolation.sh` (or a sibling).
- [ ] **Step 2: Commit** any wiring/docs.

---

## Phase C — Managed databases (original requirements: persistent state, "scale-to-zero" DBs)

> Reconciliation: request-triggered DB wake is **not feasible** (KEDA-HTTP is L7/HTTP; Postgres is TCP — verified in the analysis). This phase delivers the *intent* via **always-on or scheduled hibernation**, persistent storage, and S3 backups.

### Task C1: Parse the `database:` section of drop.yaml

**Files:** Create `src/db-config.ts`, `src/db-config.test.ts`

- [ ] Steps mirror `app-config.ts`: `DatabaseConfig { name?, engine: "postgres-18", storage: string, hibernation?: "none"|"scheduled" }`, `sanitizeDatabaseConfig`, `parseDatabaseConfig(text)`. TDD; default `engine: postgres-18` (match the repo standard, not the analysis's stale `postgres-16`), default `storage: 10Gi`. Commit.

### Task C2: CNPG Cluster + ScheduledBackup manifest builder

**Files:** Create `src/kube/cnpg.ts`, `src/kube/cnpg.test.ts`

- [ ] TDD a pure `databaseManifests(db, ctx)` → `{ cluster, scheduledBackup }` where `cluster` is `postgresql.cnpg.io/v1` `Cluster` (`instances: 1`, `storage.size`, `resources.limits`) in the tenant namespace, and `scheduledBackup` targets the existing S3 bucket via a Barman object-store (`backup.barmanObjectStore` with the bucket + IRSA/credentials). Commit.

### Task C3: `POST /v1/databases/:name` endpoint + `db` authz action

**Files:** Modify `src/authz/permissions.ts` (`"db:create"`), `src/api/server.ts`; Test `src/api/server.test.ts`

- [ ] TDD: endpoint claims the name as `type:"database"` in the tenant namespace, applies the CNPG `Cluster` + `ScheduledBackup` via `KubeClient` (add `applyDatabase`), stores the version/pointer, returns a connection reference (not the password). Reuse the claim/namespace machinery from Phase A. Commit.

### Task C4: CLI `drop db:create` + platform-mediated `db:proxy`

**Files:** Modify `src/cli/commands.ts`, `src/cli/client.ts`, `src/mcp/server.ts`

- [ ] `drop db:create <name>` → `POST /v1/databases/:name`. `drop db:proxy <name>` → a **platform-mediated** authorized proxy (the API issues a short-lived, scoped tunnel; **not** raw `kubectl port-forward`, which bypasses authz — explicitly avoid the SEC anti-pattern). Commit.

### Task C5: Scheduled hibernation controller (cost intent without request-wake)

**Files:** Modify `infra/local/compute-up.sh` (a small `CronJob`) or `src/...`

- [ ] A `CronJob` (or API job) that toggles CNPG `cnpg.io/hibernation=on/off` on DBs idle past a window (opt-in via `database.hibernation: scheduled`). Document that this is the feasible substitute for request-triggered DB wake. Commit.

---

## Verification (end-to-end, on the live Floci/k3s stack)

1. `make compute-up` (Floci EKS=k3s + KEDA + KEDA-HTTP + CNPG + gVisor RuntimeClass).
2. `./infra/local/verify-isolation.sh` — asserts every finding is fixed: per-owner namespaces, NetworkPolicy blocks cross-tenant traffic, ResourceQuota + LimitRange present, no unbounded app, env in Secret, sandbox RuntimeClass on untrusted apps.
3. Re-run the original limits probes (CPU throttle + memory OOM) — still pass (no regression).
4. Deploy a static site + two apps + one database, each under different owners; verify isolation + that apps serve via the edge and the DB is reachable via `db:proxy`.
5. `bun test && npx tsc --noEmit && node build.mjs` — unit/integration green, bundle clean (no `@kubernetes/client-node`).

## Original-requirements coverage (no regression)

| Requirement | Status after this plan |
|---|---|
| Scale-to-zero (apps) | preserved (KEDA HTTPScaledObject; edge now fronts the interceptor — B1) |
| Hard cgroup limits | preserved + **defaults added** (A2/A3) so nothing is unbounded |
| Persistent state | databases on CNPG with PVCs + **S3 backups** (C2) |
| "Scale-to-zero" DBs | scheduled hibernation (C5) — request-wake reconciled as infeasible |
| Arbitrary Docker images | enabled **safely** — sandbox RuntimeClass + PSA + NetworkPolicy (A2/A4/A7) |
| ECR / IRSA | unchanged (image pulls + S3/Barman via IRSA) |
| `drop.yaml` | extended (`database:` section — C1), `site:`/`app:` unchanged |
| Bare-minimum footprint | preserved (compute opt-in; `node:https` KubeClient; no new heavy deps) |

## Self-Review

- **Finding coverage:** SEC-1 (A2 NetworkPolicy + A4 ingress), SEC-2 (A4 RuntimeClass + A7 gVisor), SEC-3 (A2 PSA labels enforce baseline/restricted), SEC-4 (A1 + A6 per-tenant ns), SEC-5 (A4 env Secret); LIM-1 (A2 LimitRange + A3 defaults), LIM-2 (A2 ResourceQuota), LIM-3 (A2 `count/pods`/`count/services` quota). ✓ all mapped.
- **Original requirements:** table above — all preserved or completed.
- **Type consistency:** `tenantNamespace`, `tenantManifests`, `TenantManifests`, `AppManifests{secret,ingressPolicy}`, `ManifestContext{sandbox}`, `KubeClient.applyTenant/applyDatabase`, `databaseManifests` used consistently across tasks.
- **Sequencing:** Phase A is the security gate (do first); B and C are independent and each shippable.

---

*Ships as three independently-valuable phases. Phase A is the priority — it converts the platform from "internal-trusted-only, single-namespace" to a real multi-tenant, isolated, quota'd compute plane, which is the prerequisite the live findings (and the v2 analysis) identified for untrusted multi-tenancy.*
