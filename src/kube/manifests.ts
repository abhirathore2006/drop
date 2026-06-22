// Pure translator: AppConfig (+ tenant) → the Kubernetes objects that run it. No
// cluster access here — a deterministic mapping the API applies via a KubeClient.
// v1 is 443-only (one HTTP service); scaling is owned by the KEDA HTTP Add-on
// (HTTPScaledObject), so the Deployment intentionally omits spec.replicas.
import { type AppConfig, assertHttpOnly } from "../app-config.ts";

export interface ManifestContext {
  name: string; // claimed workload name (DNS-safe)
  namespace: string; // tenant namespace
  host: string; // <name>.<baseDomain> — the registered HTTPScaledObject host
  sandbox?: boolean; // run under the gVisor RuntimeClass (untrusted tenants; prod only)
}
export interface AppManifests {
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  httpScaledObject: Record<string, unknown>;
  ingressPolicy: Record<string, unknown>; // let the KEDA interceptor reach this app
  secret?: Record<string, unknown>; // env (omitted when the app has no env)
}
export interface TenantManifests {
  namespace: Record<string, unknown>;
  networkPolicy: Record<string, unknown>;
  resourceQuota: Record<string, unknown>;
  limitRange: Record<string, unknown>;
}

const SERVICE_PORT = 80;
const DEFAULT_SCALE = { min: 0, max: 3 };
const KEDA_NAMESPACE = "keda"; // where the KEDA HTTP add-on interceptor runs

// The cloud instance-metadata endpoint — same IP on AWS/GCP/Azure, so it's always
// excluded from the egress allowlist regardless of cluster CIDRs.
const IMDS_CIDR = "169.254.169.254/32";
// Fallback in-cluster CIDR excluded from the HTTPS allowlist when none is configured.
// Matches LOCAL k3s (pod 10.42/16 + service 10.43/16, both inside 10/8). PROD EKS
// often uses pod/service CIDRs OUTSIDE 10/8 (172.16/12, 100.64/10) — the operator
// MUST override this via config (DROP_BLOCKED_EGRESS_CIDRS) or cross-tenant 443
// egress is silently left open. See tenantManifests opts.blockedEgressCidrs.
const DEFAULT_BLOCKED_EGRESS_CIDRS = ["10.0.0.0/8"];

// Per-tenant defaults (conservative caps for v1; tunable via config later).
const QUOTA = { "limits.cpu": "4", "limits.memory": "8Gi", "count/pods": "20", "count/services": "10" };
const LIMITRANGE_DEFAULT = { cpu: "0.5", memory: "512Mi" };
const LIMITRANGE_DEFAULT_REQUEST = { cpu: "100m", memory: "128Mi" };

/** Per-tenant isolation objects: a PSA-labeled Namespace, a default-deny
 *  NetworkPolicy (intra-ns + DNS + an HTTPS egress allowlist that excludes the
 *  metadata IP + the in-cluster/control-plane CIDRs), a ResourceQuota, and a
 *  default LimitRange. `opts.blockedEgressCidrs` MUST cover the live cluster's
 *  pod+service CIDRs (sourced from config) — they're what keeps cross-tenant and
 *  platform-DB traffic off the 443 allowlist on clusters whose CIDRs aren't in 10/8. */
export function tenantManifests(namespace: string, opts: { blockedEgressCidrs?: string[] } = {}): TenantManifests {
  const blocked = opts.blockedEgressCidrs && opts.blockedEgressCidrs.length > 0 ? opts.blockedEgressCidrs : DEFAULT_BLOCKED_EGRESS_CIDRS;
  const labels = {
    "app.kubernetes.io/managed-by": "drop",
    "pod-security.kubernetes.io/enforce": "baseline",
    "pod-security.kubernetes.io/warn": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
  };
  return {
    namespace: { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels } },
    networkPolicy: {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "drop-default-deny", namespace },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [{ from: [{ podSelector: {} }] }], // intra-namespace ingress only (interceptor allowed per-app)
        egress: [
          { to: [{ podSelector: {} }] }, // intra-namespace (incl. the tenant's own DB)
          { to: [{ namespaceSelector: {} }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }, // DNS
          {
            // Default-deny (above) already blocks ALL egress except intra-namespace +
            // DNS — so cross-tenant pods/Services on other ports, the in-cluster API,
            // and IMDS over port 80 are unreachable irrespective of this rule. This rule
            // re-opens ONLY outbound HTTPS to the public internet and EXCLUDES the cloud
            // metadata IP + the config-driven in-cluster/control-plane CIDRs, so an app
            // still can't reach the platform DB or another tenant over 443. `blocked`
            // MUST cover the live pod+service CIDRs (on EKS those are often NOT in 10/8).
            to: [{ ipBlock: { cidr: "0.0.0.0/0", except: [IMDS_CIDR, ...blocked] } }],
            ports: [{ protocol: "TCP", port: 443 }],
          },
        ],
      },
    },
    resourceQuota: { apiVersion: "v1", kind: "ResourceQuota", metadata: { name: "drop-quota", namespace }, spec: { hard: QUOTA } },
    limitRange: {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: "drop-defaults", namespace },
      spec: { limits: [{ type: "Container", default: LIMITRANGE_DEFAULT, defaultRequest: LIMITRANGE_DEFAULT_REQUEST }] },
    },
  };
}

export function appManifests(app: AppConfig, ctx: ManifestContext): AppManifests {
  assertHttpOnly(app); // v1 guard: exactly one HTTP service
  const containerPort = app.services[0]!.internalPort;
  const labels = {
    "app.kubernetes.io/name": ctx.name,
    "app.kubernetes.io/managed-by": "drop",
    "drop.dev/workload": ctx.name,
  };
  const hasEnv = !!app.env && Object.keys(app.env).length > 0;
  const secretName = `${ctx.name}-env`;
  const limits = app.resources
    ? { ...(app.resources.cpu ? { cpu: app.resources.cpu } : {}), ...(app.resources.memory ? { memory: app.resources.memory } : {}) }
    : undefined;
  const scale = app.scale ?? DEFAULT_SCALE;

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: ctx.name, namespace: ctx.namespace, labels },
    spec: {
      // no `replicas`: the HTTPScaledObject owns the replica count (0..max)
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          ...(ctx.sandbox ? { runtimeClassName: "gvisor" } : {}),
          containers: [
            {
              name: ctx.name,
              image: app.image,
              ports: [{ containerPort }],
              // env lives in Secrets (not plaintext in the pod spec) — SEC-5. Two sources:
              //  - <name>-env: non-secret config from drop.yaml app.env (only when present).
              //  - <name>-secret: write-only app secrets managed out-of-band (CLI/dashboard/MCP),
              //    written by the SecretStore / synced by ESO. Listed LAST so a secret overrides a
              //    same-named config value; optional so a not-yet-created Secret never blocks startup.
              envFrom: [
                ...(hasEnv ? [{ secretRef: { name: secretName } }] : []),
                { secretRef: { name: `${ctx.name}-secret`, optional: true } },
              ],
              ...(limits ? { resources: { limits, requests: limits } } : {}),
              // Minimal, non-breaking baseline: block privilege escalation + default
              // seccomp, but DON'T drop caps (most official images chown/setuid at
              // entrypoint and break under `drop: ALL`). Stronger isolation is the
              // tenant/PSA/sandbox layer (tenantManifests + optional gVisor).
              securityContext: {
                allowPrivilegeEscalation: false,
                seccompProfile: { type: "RuntimeDefault" },
              },
            },
          ],
        },
      },
    },
  };

  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: ctx.name, namespace: ctx.namespace, labels },
    spec: { selector: labels, ports: [{ name: "http", port: SERVICE_PORT, targetPort: containerPort }] },
  };

  const httpScaledObject = {
    apiVersion: "http.keda.sh/v1alpha1",
    kind: "HTTPScaledObject",
    metadata: { name: ctx.name, namespace: ctx.namespace, labels },
    spec: {
      hosts: [ctx.host],
      scaleTargetRef: { name: ctx.name, kind: "Deployment", apiVersion: "apps/v1", service: ctx.name, port: SERVICE_PORT },
      replicas: { min: scale.min, max: scale.max },
      scaledownPeriod: 300,
    },
  };

  // Allow the KEDA interceptor (in the keda namespace) to reach this app's pods on
  // the CONTAINER port. The keda namespace is matched by its immutable, control-plane
  // -injected label — NOT a custom `name: keda` label (which isn't applied by helm).
  const ingressPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: `${ctx.name}-allow-interceptor`, namespace: ctx.namespace, labels },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": KEDA_NAMESPACE } } }],
          ports: [{ protocol: "TCP", port: containerPort }],
        },
      ],
    },
  };

  const out: AppManifests = { deployment, service, httpScaledObject, ingressPolicy };
  if (hasEnv) {
    out.secret = { apiVersion: "v1", kind: "Secret", metadata: { name: secretName, namespace: ctx.namespace, labels }, stringData: app.env };
  }
  return out;
}
