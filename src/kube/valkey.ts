// Pure translator: CacheConfig (+ tenant) → the Kubernetes objects that run a managed Valkey
// (cache/queue). No cluster access here — a deterministic mapping the API applies via a KubeClient
// (mirrors manifests.ts for apps / cnpg.ts for databases).
//
// Deliberately tiny — the anti-Redis-Cluster: ONE replica, no HA, no clustering. EPHEMERAL by default
// (Deployment with an emptyDir-less pod → a restart loses the data); `persistent: true` adds a small
// RWO PVC at /data with RDB snapshots (strategy: Recreate so the RWO volume never double-attaches).
// Auth: `requirepass` is a platform-GENERATED password delivered via a `<name>-cache` Secret and read
// by the container through a secretKeyRef env var, expanded into the arg by k8s' `$(VAR)` substitution
// (no shell, no plaintext in the pod spec). See the API for the REDIS_URL binding (src/api/server.ts).
import { type CacheConfig, cacheMemoryToBytes, cachePvcSize } from "../cache-config.ts";

// Pinned Valkey image (Redis-compatible, BSD-licensed). Bump deliberately (air-gap mirror note in Helm).
export const VALKEY_IMAGE = "docker.io/valkey/valkey:8";
const CACHE_PORT = 6379;
const CACHE_CPU = "250m"; // a tiny cache doesn't need more; memory is the real knob (limit = cfg.memory)

export interface CacheManifestContext {
  name: string; // claimed workload name (DNS-safe) — the Deployment/Service/Secret base name
  namespace: string; // tenant namespace
  // The generated `requirepass` password, set ONLY at create. Present → emit the platform-owned
  // `<name>-cache` Secret (stringData.password). Absent on a re-apply (update) so the password is
  // never silently rotated and the existing Secret stands — same posture as CNPG's appPassword.
  password?: string;
}

export interface CacheManifests {
  deployment: Record<string, unknown>; // single-replica Valkey Deployment (Recreate strategy)
  service: Record<string, unknown>; // ClusterIP Service on 6379
  secret?: Record<string, unknown>; // `<name>-cache` requirepass Secret — set only at create (ctx.password present)
  pvc?: Record<string, unknown>; // small RWO PVC at /data — only when cfg.persistent
}

/** The in-namespace DNS host an app connects to (`<name>.<ns>.svc.cluster.local`). */
export function cacheHost(name: string, namespace: string): string {
  return `${name}.${namespace}.svc.cluster.local`;
}

/** Build the Valkey objects for one managed cache in a tenant namespace. */
export function cacheManifests(cfg: CacheConfig, ctx: CacheManifestContext): CacheManifests {
  const labels = {
    "app.kubernetes.io/name": ctx.name,
    "app.kubernetes.io/managed-by": "drop",
    "drop.dev/workload": ctx.name,
    "drop.dev/kind": "cache", // teardown / status select caches distinctly from apps
  };
  const secretName = `${ctx.name}-cache`;
  const pvcName = `${ctx.name}-cache-data`;

  // maxmemory ≈ 90% of the pod limit so Valkey rejects writes (noeviction) BEFORE the kernel OOM-kills
  // the pod — leaving headroom for Valkey's own overhead + copy-on-write during an RDB save. Passed as a
  // raw byte count (Valkey doesn't parse the "Mi"/"Gi" k8s suffix). Falls back to the whole limit if the
  // (already-sanitized) quantity somehow won't parse.
  const memBytes = cacheMemoryToBytes(cfg.memory) ?? 0;
  const maxmemoryBytes = memBytes > 0 ? Math.floor(memBytes * 0.9) : 0;

  // Valkey args. `$(VALKEY_PASSWORD)` is expanded by k8s from the secretKeyRef env var (NOT a shell) so
  // the plaintext never lands in the pod spec. noeviction (the default) keeps queue jobs from being
  // silently dropped under memory pressure — a cache user who wants LRU can front it themselves.
  const args = ["--requirepass", "$(VALKEY_PASSWORD)", "--maxmemory-policy", "noeviction"];
  if (maxmemoryBytes > 0) args.push("--maxmemory", String(maxmemoryBytes));
  if (cfg.persistent) {
    // RDB snapshot: save if ≥1 key changed in 60s. AOF off (RDB is enough for this primitive).
    args.push("--dir", "/data", "--save", "60", "1", "--appendonly", "no");
  } else {
    args.push("--save", ""); // EPHEMERAL: disable RDB entirely — no persistence, restart loses data (documented loudly)
  }

  const container: Record<string, unknown> = {
    name: "valkey",
    image: VALKEY_IMAGE,
    imagePullPolicy: "IfNotPresent", // pinned tag (never :latest) → cache it on the node
    command: ["valkey-server"],
    args,
    ports: [{ containerPort: CACHE_PORT, name: "redis" }],
    env: [{ name: "VALKEY_PASSWORD", valueFrom: { secretKeyRef: { name: secretName, key: "password" } } }],
    // A TCP-socket probe (not an authed PING) so the probe never needs the password: liveness restarts a
    // wedged process, readiness gates the Service. Bounds are conservative for a fast-booting cache.
    readinessProbe: { tcpSocket: { port: CACHE_PORT }, periodSeconds: 10, timeoutSeconds: 2 },
    livenessProbe: { tcpSocket: { port: CACHE_PORT }, periodSeconds: 10, timeoutSeconds: 2, failureThreshold: 3 },
    resources: { limits: { cpu: CACHE_CPU, memory: cfg.memory }, requests: { cpu: CACHE_CPU, memory: cfg.memory } },
    securityContext: { allowPrivilegeEscalation: false, seccompProfile: { type: "RuntimeDefault" } },
    ...(cfg.persistent ? { volumeMounts: [{ name: "data", mountPath: "/data" }] } : {}),
  };

  const out: CacheManifests = {
    deployment: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels },
      spec: {
        replicas: 1,
        // Recreate (never two pods): a single-replica cache has no HA to preserve, and a persistent
        // one's RWO PVC must never double-attach during a rollout (same reasoning as I5 stateful apps).
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [container],
            ...(cfg.persistent ? { volumes: [{ name: "data", persistentVolumeClaim: { claimName: pvcName } }] } : {}),
          },
        },
      },
    },
    service: {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels },
      spec: { selector: labels, ports: [{ name: "redis", port: CACHE_PORT, targetPort: CACHE_PORT }] },
    },
  };

  // The requirepass Secret is emitted only at create (ctx.password present) — the source of truth for
  // the container's env AND (read back) the REDIS_URL binding. On a re-apply it already exists.
  if (ctx.password) {
    out.secret = {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: { name: secretName, namespace: ctx.namespace, labels },
      stringData: { password: ctx.password },
    };
  }
  // Persistent caches get one small RWO PVC (sized to the cache memory). EPHEMERAL is the DEFAULT — no
  // PVC, no persistence, a restart loses everything (documented loudly in docs/cache.html).
  if (cfg.persistent) {
    out.pvc = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: pvcName, namespace: ctx.namespace, labels },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: cachePvcSize(cfg) } } },
    };
  }
  return out;
}
