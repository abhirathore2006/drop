// AWS Secrets Manager backend (default in prod; runs against Floci's SM emulation locally). Each
// secret is its OWN provider secret at `<prefix>/<namespace>/<app>/<KEY>` — strict write-only, no
// merge-read. Injection is via the External Secrets Operator: the platform reconciles a per-app
// ExternalSecret (explicit per-key remoteRefs) → ESO produces the `<app>-secret` k8s Secret → the
// Deployment envFroms it. The app/Deployment never know the backend.
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  ListSecretsCommand,
} from "@aws-sdk/client-secrets-manager";
import { appSecretName, type SecretScope, type SecretStore } from "./types.ts";
import { externalSecret } from "./eso.ts";

// The slice of KubeApiClient this backend needs (so it's unit-testable without a cluster).
export interface EsoApplier {
  applyExternalSecret(namespace: string, name: string, obj: Record<string, unknown>): Promise<void>;
  deleteExternalSecret(namespace: string, name: string): Promise<void>;
  deleteSecretObject(namespace: string, name: string): Promise<void>;
}

// Minimal shape of the SM client we use (lets tests inject a fake).
export interface SmClient {
  send(command: unknown): Promise<any>;
}

export interface AwsSecretsManagerOptions {
  region: string;
  endpoint?: string; // Floci locally; omit for real AWS (→ IRSA via the default credential chain)
  accessKeyId?: string;
  secretAccessKey?: string;
  storeName: string; // the ESO ClusterSecretStore the ExternalSecrets reference
  pathPrefix: string; // → <prefix>/<namespace>/<app>/<KEY>
  kube: EsoApplier;
  client?: SmClient; // injectable for tests
}

export class AwsSecretsManagerStore implements SecretStore {
  private sm: SmClient;
  constructor(private o: AwsSecretsManagerOptions) {
    this.sm =
      o.client ??
      new SecretsManagerClient({
        region: o.region,
        ...(o.endpoint ? { endpoint: o.endpoint } : {}),
        ...(o.accessKeyId && o.secretAccessKey ? { credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } } : {}),
      });
  }

  private smName(s: SecretScope, key: string): string {
    return `${this.o.pathPrefix}/${s.namespace}/${s.app}/${key}`;
  }
  private prefix(s: SecretScope): string {
    return `${this.o.pathPrefix}/${s.namespace}/${s.app}/`;
  }

  async setSecret(s: SecretScope, key: string, value: string): Promise<void> {
    const Name = this.smName(s, key);
    try {
      await this.sm.send(new CreateSecretCommand({ Name, SecretString: value }));
    } catch (e: any) {
      if (e?.name === "ResourceExistsException") await this.sm.send(new PutSecretValueCommand({ SecretId: Name, SecretString: value }));
      else throw e;
    }
  }

  async deleteSecret(s: SecretScope, key: string): Promise<void> {
    try {
      await this.sm.send(new DeleteSecretCommand({ SecretId: this.smName(s, key), ForceDeleteWithoutRecovery: true }));
    } catch (e: any) {
      if (e?.name !== "ResourceNotFoundException") throw e;
    }
  }

  async listKeys(s: SecretScope): Promise<string[]> {
    const p = this.prefix(s);
    const out: string[] = [];
    let next: string | undefined;
    do {
      const r: any = await this.sm.send(new ListSecretsCommand({ NextToken: next, Filters: [{ Key: "name", Values: [p] }] }));
      for (const sec of r.SecretList ?? []) if (sec.Name?.startsWith(p)) out.push(sec.Name.slice(p.length));
      next = r.NextToken;
    } while (next);
    return out.sort();
  }

  async ensureBinding(s: SecretScope, keys: string[]): Promise<void> {
    const ns = s.namespace;
    const name = appSecretName(s.app);
    if (keys.length === 0) {
      await this.o.kube.deleteExternalSecret(ns, name); // ESO (Owner) then removes the <app>-secret
      return;
    }
    const es = externalSecret({ name, namespace: ns, storeName: this.o.storeName, refs: keys.map((k) => ({ key: k, remoteName: this.smName(s, k) })) });
    await this.o.kube.applyExternalSecret(ns, name, es);
  }

  async destroy(s: SecretScope): Promise<void> {
    await this.o.kube.deleteExternalSecret(s.namespace, appSecretName(s.app)).catch(() => {});
    for (const k of await this.listKeys(s).catch(() => [] as string[])) await this.deleteSecret(s, k);
    await this.o.kube.deleteSecretObject(s.namespace, appSecretName(s.app)).catch(() => {});
  }
}
