import type { AppManifests, TenantManifests } from "./manifests.ts";
import type { DatabaseManifests } from "./cnpg.ts";

// The cluster boundary. The API depends on this port, never on a concrete k8s
// client — so deploy logic is testable with FakeKube (no cluster), exactly as
// the API uses BlobStore/FakeBlob for S3. A real impl (k8s API / server-side
// apply) lands when a cluster is available.
export interface KubeClient {
  /** Create-or-update the per-tenant Namespace + NetworkPolicy + ResourceQuota + LimitRange (idempotent). */
  applyTenant(namespace: string, manifests: TenantManifests): Promise<void>;
  /** Create-or-update the app's Deployment + Service + HTTPScaledObject + Secret + ingress policy (idempotent). */
  applyApp(namespace: string, name: string, manifests: AppManifests): Promise<void>;
  /** Remove the app's objects. Safe if absent. */
  deleteApp(namespace: string, name: string): Promise<void>;
  /** Return the currently-applied manifests for an app, or null if none. */
  getApp(namespace: string, name: string): Promise<AppManifests | null>;
  /** Create-or-update a managed database: CNPG ObjectStore + Cluster + ScheduledBackup + NetworkPolicy (+ creds Secret). */
  applyDatabase(namespace: string, name: string, manifests: DatabaseManifests): Promise<void>;
  /** Remove the database's CNPG objects. Safe if absent. */
  deleteDatabase(namespace: string, name: string): Promise<void>;
}
