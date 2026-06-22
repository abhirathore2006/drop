// Composition root for the SecretStore: pick the backend at deploy time (DROP_SECRET_BACKEND).
import type { Config } from "../config.ts";
import type { KubeApiClient } from "../kube/client.ts";
import { KubeSecretStore } from "./kube-store.ts";
import { AwsSecretsManagerStore } from "./aws-store.ts";
import type { SecretScope, SecretStore } from "./types.ts";

// Used when compute is disabled (no kubeconfig): there are no apps, so the secrets endpoints 501
// before this is ever called. Present only to satisfy the required Deps.secrets.
class NoopSecretStore implements SecretStore {
  async setSecret(): Promise<void> {
    throw new Error("compute is not enabled on this instance");
  }
  async deleteSecret(): Promise<void> {
    throw new Error("compute is not enabled on this instance");
  }
  async listKeys(_s: SecretScope): Promise<string[]> {
    return [];
  }
  async ensureBinding(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export function makeSecretStore(cfg: Config, kube?: KubeApiClient): SecretStore {
  if (!kube) return new NoopSecretStore();
  if (cfg.secretBackend === "aws") {
    return new AwsSecretsManagerStore({
      region: cfg.secretManagerRegion,
      endpoint: cfg.secretManagerEndpoint, // Floci locally; omit for real AWS (IRSA)
      accessKeyId: cfg.secretManagerKeyId,
      secretAccessKey: cfg.secretManagerSecret,
      storeName: cfg.secretStoreName,
      pathPrefix: cfg.secretPathPrefix,
      kube,
    });
  }
  return new KubeSecretStore(kube);
}
