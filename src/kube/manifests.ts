// Pure translator: an AppConfig → the Kubernetes objects that run it. No cluster
// access here — this is a deterministic mapping the API applies via a KubeClient.
// v1 is 443-only (one HTTP service); scaling is owned by the KEDA HTTP Add-on
// (HTTPScaledObject), so the Deployment intentionally omits spec.replicas.
import { type AppConfig, assertHttpOnly } from "../app-config.ts";

export interface ManifestContext {
  name: string; // claimed workload name (DNS-safe)
  namespace: string; // tenant namespace
  host: string; // <name>.<baseDomain>
}
export interface AppManifests {
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  httpScaledObject: Record<string, unknown>;
}

const SERVICE_PORT = 80;
const DEFAULT_SCALE = { min: 0, max: 3 };

export function appManifests(app: AppConfig, ctx: ManifestContext): AppManifests {
  assertHttpOnly(app); // v1 guard: exactly one HTTP service
  const containerPort = app.services[0]!.internalPort;
  const labels = {
    "app.kubernetes.io/name": ctx.name,
    "app.kubernetes.io/managed-by": "drop",
    "drop.dev/workload": ctx.name,
  };
  const env = app.env ? Object.entries(app.env).map(([name, value]) => ({ name, value })) : undefined;
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
          containers: [
            {
              name: ctx.name,
              image: app.image,
              ports: [{ containerPort }],
              ...(env ? { env } : {}),
              ...(limits ? { resources: { limits, requests: limits } } : {}),
              // baseline hardening; real multi-tenant isolation also needs a
              // RuntimeClass (gVisor/Kata) + NetworkPolicy + ResourceQuota (cluster-level).
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
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

  return { deployment, service, httpScaledObject };
}
