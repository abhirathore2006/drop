import type { AppManifests } from "./manifests.ts";

// The cluster boundary. The API depends on this port, never on a concrete k8s
// client — so deploy logic is testable with FakeKube (no cluster), exactly as
// the API uses BlobStore/FakeBlob for S3. A real impl (k8s API / server-side
// apply) lands when a cluster is available.
export interface KubeClient {
  /** Create-or-update the app's Deployment + Service + HTTPScaledObject (idempotent). */
  applyApp(namespace: string, name: string, manifests: AppManifests): Promise<void>;
  /** Remove the app's objects. Safe if absent. */
  deleteApp(namespace: string, name: string): Promise<void>;
  /** Return the currently-applied manifests for an app, or null if none. */
  getApp(namespace: string, name: string): Promise<AppManifests | null>;
}
