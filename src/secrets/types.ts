// The secret-store boundary. The API depends on this port, never on a concrete backend — so
// the same write-only secrets flow works over k8s Secrets (local) or AWS Secrets Manager / GCP /
// Azure / Vault (prod, via External Secrets Operator), chosen at deploy time. Every backend
// converges on the `<app>-secret` k8s Secret the Deployment envFroms, so apps never know the
// backend. WRITE-ONLY by construction: there is no getSecret(value) — values are never read back.

export interface SecretScope {
  owner: string; // canonical (lowercased) owner email
  app: string; // workload name
  namespace: string; // tenant namespace
}

export interface SecretStore {
  /** Create-or-overwrite a single secret. */
  setSecret(scope: SecretScope, key: string, value: string): Promise<void>;
  /** Remove a single secret. Idempotent. */
  deleteSecret(scope: SecretScope, key: string): Promise<void>;
  /** Key NAMES only (the registry of names also lives in the metastore; this is the backend view). */
  listKeys(scope: SecretScope): Promise<string[]>;
  /** Reconcile the injection wiring to exactly `keys`. No-op for the kube backend (the Deployment
   *  envFroms `<app>-secret` directly). For external backends, writes/updates the ESO ExternalSecret
   *  with one explicit remoteRef per key (and removes it when `keys` is empty). Called after every
   *  set/delete and at deploy, with the current key list from the metastore registry. */
  ensureBinding(scope: SecretScope, keys: string[]): Promise<void>;
  /** Remove ALL of an app's secret material (called on app delete). Safe if absent. */
  destroy(scope: SecretScope): Promise<void>;
}

/** The k8s Secret an app's secrets land in (envFrom'd by the Deployment). Same name for every backend. */
export const appSecretName = (app: string) => `${app}-secret`;
