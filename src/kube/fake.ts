import type { KubeClient, AppStatus, DatabaseStatus } from "./types.ts";
import type { AppManifests, TenantManifests } from "./manifests.ts";
import type { DatabaseManifests } from "./cnpg.ts";

// In-memory KubeClient for tests (mirrors FakeBlob). Records every apply so tests
// can assert what would have been sent to the cluster.
export class FakeKube implements KubeClient {
  private apps = new Map<string, AppManifests>();
  readonly tenantApplies: { namespace: string; manifests: TenantManifests }[] = [];
  readonly applies: { namespace: string; name: string; manifests: AppManifests }[] = [];
  readonly deletes: { namespace: string; name: string }[] = [];
  readonly dbApplies: { namespace: string; name: string; manifests: DatabaseManifests }[] = [];
  readonly dbDeletes: { namespace: string; name: string }[] = [];

  private key(ns: string, name: string): string {
    return `${ns}/${name}`;
  }

  async applyTenant(namespace: string, manifests: TenantManifests): Promise<void> {
    this.tenantApplies.push({ namespace, manifests });
  }

  async applyApp(namespace: string, name: string, manifests: AppManifests): Promise<void> {
    this.apps.set(this.key(namespace, name), manifests);
    this.applies.push({ namespace, name, manifests });
  }

  async deleteApp(namespace: string, name: string): Promise<void> {
    this.apps.delete(this.key(namespace, name));
    this.deletes.push({ namespace, name });
  }

  async getApp(namespace: string, name: string): Promise<AppManifests | null> {
    return this.apps.get(this.key(namespace, name)) ?? null;
  }

  async applyDatabase(namespace: string, name: string, manifests: DatabaseManifests): Promise<void> {
    this.dbApplies.push({ namespace, name, manifests });
    this.dbs.add(this.key(namespace, name));
  }

  async deleteDatabase(namespace: string, name: string): Promise<void> {
    this.dbDeletes.push({ namespace, name });
    this.dbs.delete(this.key(namespace, name));
  }

  // Live-status doubles. Tests can preset specific values via statusOverride; otherwise an
  // applied app/db reports a healthy default and an absent one reports null.
  private dbs = new Set<string>();
  readonly statusOverride = new Map<string, AppStatus | DatabaseStatus>();

  async getAppStatus(namespace: string, name: string): Promise<AppStatus | null> {
    const k = this.key(namespace, name);
    if (this.statusOverride.has(k)) return this.statusOverride.get(k) as AppStatus;
    return this.apps.has(k) ? { replicas: 1, ready: 1, restarts: 0, reason: "Running" } : null;
  }

  async getDatabaseStatus(namespace: string, name: string): Promise<DatabaseStatus | null> {
    const k = this.key(namespace, name);
    if (this.statusOverride.has(k)) return this.statusOverride.get(k) as DatabaseStatus;
    return this.dbs.has(k) ? { phase: "Cluster in healthy state", ready: 1, instances: 1 } : null;
  }

  readonly logsByName = new Map<string, string>();
  async getWorkloadLogs(namespace: string, name: string): Promise<string> {
    return this.logsByName.get(this.key(namespace, name)) ?? "";
  }
}
