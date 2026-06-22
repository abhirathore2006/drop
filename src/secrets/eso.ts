// The External Secrets Operator manifest that injects an app's secrets. We use EXPLICIT per-key
// remoteRefs (not dataFrom.find.path) so: (a) env-var names are exactly the keys, (b) we never
// depend on the provider honoring a list-prefix filter, and (c) there is no cross-app bleed. The
// platform reconciles `data` to the current key set on every set/delete and at deploy.
export interface ExternalSecretOpts {
  name: string; // the ExternalSecret (and target k8s Secret) name — <app>-secret
  namespace: string; // tenant namespace
  storeName: string; // the ESO ClusterSecretStore (e.g. "floci" locally, an IRSA store in prod)
  refs: { key: string; remoteName: string }[]; // env-var key -> provider secret name
}

export function externalSecret(o: ExternalSecretOpts): Record<string, unknown> {
  return {
    apiVersion: "external-secrets.io/v1",
    kind: "ExternalSecret",
    metadata: { name: o.name, namespace: o.namespace, labels: { "app.kubernetes.io/managed-by": "drop" } },
    spec: {
      refreshInterval: "1m",
      secretStoreRef: { name: o.storeName, kind: "ClusterSecretStore" },
      target: { name: o.name, creationPolicy: "Owner" }, // ESO owns/creates the <app>-secret k8s Secret
      data: o.refs.map((r) => ({ secretKey: r.key, remoteRef: { key: r.remoteName } })),
    },
  };
}
