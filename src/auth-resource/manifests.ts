// Pure translator: AuthConfig + AuthEngine (+ tenant/db context) → the Kubernetes objects that run a
// managed auth resource (K1). No cluster access here — a deterministic mapping the API applies via a
// KubeClient (mirrors kube/manifests.ts for apps / kube/valkey.ts for caches).
//
// The engine runs as an app-shaped Deployment PINNED to 1/1 (auth can't cold-start on a login — a
// scaled-to-zero engine would drop the first sign-in). Routing is the normal edge: an HTTPScaledObject
// registers `auth--<name>.<baseDomain>` with the KEDA interceptor (min:1 keeps it warm, so the
// interceptor routes without a cold start), and the edge special-cases `type: auth` hosts (see
// src/edge/auth-exempt.ts). It reuses the B1 DB-binding mechanics for its OWN Postgres connection.
//
// DB URL COMPOSITION (the carefully-tested bit): GoTrue wants a single `GOTRUE_DB_DATABASE_URL`, but
// the DB creds live in the CNPG `<db>-app` Secret (username/password keys). k8s `envFrom` vars can't
// be referenced by `$(VAR)` interpolation — only earlier `env` entries can — so we pull username +
// password into explicit `env` `valueFrom` secretKeyRef entries FIRST, then compose the URL with
// `$(DB_USER)`/`$(DB_PASSWORD)` in a LATER entry (k8s expands them because they're defined earlier in
// the SAME container's env list). The password is base64url (URL-safe), and host/db are static, so
// the resulting DSN is well-formed. sslmode=verify-full + sslrootcert point at the mounted CA.
import { dbCaBinding } from "../kube/manifests.ts";
import type { AuthConfig } from "../auth-config.ts";
import type { AuthEngine } from "./engine.ts";

const KEDA_NAMESPACE = "keda"; // where the KEDA HTTP add-on interceptor runs (matches kube/manifests.ts)
const AUTH_CPU = "250m";
const AUTH_MEMORY = "256Mi";

export interface AuthManifestContext {
  name: string; // the auth resource (workload) name — the Deployment/Service base name
  namespace: string; // tenant namespace
  host: string; // auth--<name>.<baseDomain> — the registered HTTPScaledObject host
  db: string; // the bound database name (its `<db>-app` Secret + `<db>-ca` CA are wired in)
  // The generated HS256 JWT secret, set ONLY at create/rotate. Present → emit the write-only
  // `<name>-auth-keys` Secret. Absent on a plain re-apply so the secret is never silently rotated.
  jwtSecret?: string;
}

export interface AuthManifests {
  deployment: Record<string, unknown>; // GoTrue Deployment, replicas pinned via the HTTPScaledObject (1/1)
  service: Record<string, unknown>; // ClusterIP Service on the engine port
  httpScaledObject: Record<string, unknown>; // registers auth--<name> host with the interceptor (min:1/max:1)
  ingressPolicy: Record<string, unknown>; // let the KEDA interceptor reach the engine pod
  keysSecret?: Record<string, unknown>; // `<name>-auth-keys` (jwt-secret) — set only at create/rotate
}

/** The in-cluster URL an app/binding reaches the engine at externally is auth--<name>.<base>; this is
 *  the PUBLIC external URL used for API_EXTERNAL_URL + provider redirect URIs. */
export function authExternalUrl(name: string, baseDomain: string): string {
  return `https://auth--${name}.${baseDomain}`;
}

/** Build the Kubernetes objects for one managed auth resource. `engine` is the AuthEngine port impl. */
export function authManifests(cfg: AuthConfig, engine: AuthEngine, ctx: AuthManifestContext): AuthManifests {
  const labels = {
    "app.kubernetes.io/name": ctx.name, // getAuthStatus reuses the app-status path (this selector)
    "app.kubernetes.io/managed-by": "drop",
    "drop.dev/workload": ctx.name,
    "drop.dev/kind": "auth", // teardown / status select auth resources distinctly from apps
  };
  const keysSecretName = `${ctx.name}-auth-keys`;
  const providerSecretName = `${ctx.name}-secret`; // write-only provider secrets (drop secrets set)
  const dbSecretName = `${ctx.db}-app`; // CNPG basic-auth creds (username/password keys)
  const dbHost = `${ctx.db}-rw`; // CNPG primary read-write Service
  const ca = dbCaBinding(ctx.db);
  const port = engine.containerPort;
  const apiExternalUrl = ctx.host.startsWith("http") ? ctx.host : `https://${ctx.host}`;

  // Ordered env: DB creds valueFrom FIRST (so `$(VAR)` can reference them), then the composed DSN,
  // then the JWT secret valueFrom, then the engine's plain config env.
  const env: Record<string, unknown>[] = [
    { name: "DB_USER", valueFrom: { secretKeyRef: { name: dbSecretName, key: "username" } } },
    { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: dbSecretName, key: "password" } } },
    {
      name: engine.dbUrlVar,
      // $(DB_USER)/$(DB_PASSWORD) are expanded by k8s from the earlier valueFrom entries (NOT a shell).
      value: `postgres://$(DB_USER):$(DB_PASSWORD)@${dbHost}:5432/app?sslmode=verify-full&sslrootcert=${ca.caCertPath}`,
    },
    { name: engine.jwtSecretVar, valueFrom: { secretKeyRef: { name: keysSecretName, key: "jwt-secret" } } },
    ...Object.entries(engine.envFor({ name: ctx.name, apiExternalUrl, config: cfg })).map(([name, value]) => ({ name, value })),
  ];

  const container: Record<string, unknown> = {
    name: engine.id,
    image: engine.image,
    imagePullPolicy: "IfNotPresent", // pinned tag (never :latest) → cache it on the node
    ports: [{ containerPort: port, name: "http" }],
    env,
    // Provider client SECRETS live in the write-only `<name>-secret` Secret (drop secrets set), envFrom'd
    // optional so a not-yet-created Secret never blocks startup. NEVER carries secret VALUES in this file.
    envFrom: [{ secretRef: { name: providerSecretName, optional: true } }],
    volumeMounts: [ca.volumeMount],
    // The engine can't cold-start, so a health-gated readiness probe is enough; liveness restarts a
    // wedged process. GoTrue serves `/health` unauthenticated.
    readinessProbe: { httpGet: { path: engine.healthPath, port }, periodSeconds: 10, timeoutSeconds: 2, initialDelaySeconds: 5 },
    livenessProbe: { httpGet: { path: engine.healthPath, port }, periodSeconds: 10, timeoutSeconds: 2, failureThreshold: 3 },
    resources: { limits: { cpu: AUTH_CPU, memory: AUTH_MEMORY }, requests: { cpu: AUTH_CPU, memory: AUTH_MEMORY } },
    securityContext: { allowPrivilegeEscalation: false, seccompProfile: { type: "RuntimeDefault" } },
  };

  const out: AuthManifests = {
    deployment: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels },
      spec: {
        // Recreate (never two pods at once): the engine is single-replica by contract; the
        // HTTPScaledObject owns the actual replica count (pinned 1..1 below).
        strategy: { type: "Recreate" },
        selector: { matchLabels: { "app.kubernetes.io/name": ctx.name } },
        template: {
          metadata: { labels },
          spec: { containers: [container], volumes: [ca.volume] },
        },
      },
    },
    service: {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels },
      spec: { selector: { "app.kubernetes.io/name": ctx.name }, ports: [{ name: "http", port, targetPort: port }] },
    },
    httpScaledObject: {
      apiVersion: "http.keda.sh/v1alpha1",
      kind: "HTTPScaledObject",
      metadata: { name: ctx.name, namespace: ctx.namespace, labels },
      spec: {
        hosts: [ctx.host],
        scaleTargetRef: { name: ctx.name, kind: "Deployment", apiVersion: "apps/v1", service: ctx.name, port },
        // Pinned 1/1 — auth can't cold-start on a login (min:1 keeps a pod warm; max:1 = single replica).
        replicas: { min: 1, max: 1 },
        scaledownPeriod: 300,
      },
    },
    // Allow the KEDA interceptor (keda namespace) to reach the engine pod on its container port.
    ingressPolicy: {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: `${ctx.name}-allow-interceptor`, namespace: ctx.namespace, labels },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/name": ctx.name } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": KEDA_NAMESPACE } } }],
            ports: [{ protocol: "TCP", port }],
          },
        ],
      },
    },
  };

  // The JWT-secret Secret is emitted only at create/rotate (ctx.jwtSecret present). Write-only: it's
  // the source of truth for the engine's HS256 signing key AND (read back server-side) admin-token
  // minting + the binding apps' AUTH_JWT_SECRET. On a plain re-apply it already exists and stands.
  if (ctx.jwtSecret) {
    out.keysSecret = {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: { name: keysSecretName, namespace: ctx.namespace, labels },
      stringData: { "jwt-secret": ctx.jwtSecret },
    };
  }
  return out;
}
