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
  /** Rotate the managed DB's `app` password (ALTER ROLE via an in-namespace Job, then update
   *  the `<name>-app` creds Secret). Throws if the rotation Job does not succeed. */
  setDatabasePassword(namespace: string, name: string, newPassword: string): Promise<void>;
  /** Live app status from the Deployment + pods (replicas, ready, restarts, crash reason), or null if absent. */
  getAppStatus(namespace: string, name: string): Promise<AppStatus | null>;
  /** Live CNPG database status (phase + ready/desired instances), or null if absent. */
  getDatabaseStatus(namespace: string, name: string): Promise<DatabaseStatus | null>;
  /** Recent log lines from the workload's pods (newest pod), for crash diagnostics. "" if none. */
  getWorkloadLogs(namespace: string, name: string, tailLines?: number): Promise<string>;
  /** Roll the app's pods (bump a pod-template annotation) — picks up new env/secrets. */
  restartApp(namespace: string, name: string, restartedAt: string): Promise<void>;
  /** Take the app TRULY offline: pause KEDA (pin to 0, ignore traffic) + scale the Deployment to 0. */
  stopApp(namespace: string, name: string): Promise<void>;
  /** Resume: un-pause KEDA so it scales per the HTTPScaledObject again. */
  startApp(namespace: string, name: string): Promise<void>;
  /** The tenant ResourceQuota's hard limits + current usage (drop-quota), or null if the namespace
   *  / quota isn't provisioned yet (e.g. a tenant with only static sites — no compute namespace). */
  getTenantUsage(namespace: string): Promise<TenantUsage | null>;
}

export interface TenantUsage {
  hard: Record<string, string>; // configured caps, e.g. { "limits.cpu": "4", "count/pods": "20" }
  used: Record<string, string>; // current consumption against those caps
}

/** Thrown by setDatabasePassword when the role password WAS successfully changed but persisting
 *  it to the `<name>-app` creds Secret failed. The new password is now the LIVE one, so the
 *  caller must surface it (it is the only copy) rather than report a blanket failure. */
export class PasswordSyncError extends Error {
  readonly name = "PasswordSyncError";
}

export interface AppStatus {
  replicas: number; // desired (KEDA-owned; 0 when scaled to zero)
  ready: number; // ready replicas
  restarts: number; // max container restarts across the app's pods (crash-loop signal)
  reason: string; // "Running" | a waiting reason like "CrashLoopBackOff" | "Pending" | "NoPods"
}
export interface DatabaseStatus {
  phase: string; // CNPG .status.phase, e.g. "Cluster in healthy state"
  ready: number; // ready instances
  instances: number; // desired instances
}
