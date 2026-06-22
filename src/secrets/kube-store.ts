// Local / default secret backend: write straight into the `<app>-secret` k8s Secret in the tenant
// namespace (etcd; enable a KMS encryption-at-rest provider in prod). The Deployment envFroms that
// Secret directly, so ensureBinding is a no-op. Delegates per-key merge-patches to KubeApiClient.
import { appSecretName, type SecretScope, type SecretStore } from "./types.ts";
import type { KubeApiClient } from "../kube/client.ts";

export class KubeSecretStore implements SecretStore {
  constructor(private kube: KubeApiClient) {}

  async setSecret(s: SecretScope, key: string, value: string): Promise<void> {
    await this.kube.ensureSecretKey(s.namespace, appSecretName(s.app), key, value);
  }
  async deleteSecret(s: SecretScope, key: string): Promise<void> {
    await this.kube.removeSecretKey(s.namespace, appSecretName(s.app), key);
  }
  async listKeys(s: SecretScope): Promise<string[]> {
    return this.kube.listSecretDataKeys(s.namespace, appSecretName(s.app));
  }
  async ensureBinding(_s: SecretScope, _keys: string[]): Promise<void> {
    /* no-op: setSecret/deleteSecret write the <app>-secret Secret directly, which the
       Deployment envFroms — there is no external sync to reconcile. */
  }
  async destroy(s: SecretScope): Promise<void> {
    await this.kube.deleteSecretObject(s.namespace, appSecretName(s.app));
  }
}
