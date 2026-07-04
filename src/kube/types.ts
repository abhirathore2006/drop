import type { Readable } from "node:stream";
import type { AppManifests, TenantManifests } from "./manifests.ts";
import type { DatabaseManifests } from "./cnpg.ts";

// The cluster boundary. The API depends on this port, never on a concrete k8s
// client — so deploy logic is testable with FakeKube (no cluster), exactly as
// the API uses BlobStore/FakeBlob for S3. A real impl (k8s API / server-side
// apply) lands when a cluster is available.
export interface KubeClient {
  /** Create-or-update the per-tenant Namespace + NetworkPolicy + ResourceQuota + LimitRange, plus the
   *  (A2b) per-workload "allow from edge-tcp" NetworkPolicies — pruning any left from a now-unexposed
   *  workload. Idempotent. */
  applyTenant(namespace: string, manifests: TenantManifests): Promise<void>;
  /** (A2b) Set the edge-tcp Service's published port list in the platform namespace — the AWS LB
   *  controller reconciles NLB listeners from it. Called on expose/unexpose so a dynamic port gets a
   *  listener only while it's live. The shared (SNI/PG) ports are always included by the caller. */
  patchEdgeTcpPorts(namespace: string, service: string, ports: { name: string; port: number }[]): Promise<void>;
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
  /** Live status of EVERY app (web Deployment) in a namespace, keyed by app name — ONE aggregated
   *  Deployments+pods list, so the stack graph reads N apps with 2 calls instead of 2N (C1). Absent
   *  apps are simply not in the map; a cluster-read failure degrades to an empty map, never throws. */
  listNamespaceAppStatuses(namespace: string): Promise<Record<string, AppStatus>>;
  /** Live status of EVERY managed database (CNPG Cluster) in a namespace, keyed by name — ONE
   *  aggregated Clusters list (C1). Same degradation posture as listNamespaceAppStatuses. */
  listNamespaceDatabaseStatuses(namespace: string): Promise<Record<string, DatabaseStatus>>;
  /** Recent log lines from the workload's pods (newest pod), for crash diagnostics. "" if none. */
  getWorkloadLogs(namespace: string, name: string, tailLines?: number): Promise<string>;
  /** Follow a workload's logs (kube `follow=true`), starting `tailLines` back (G1, `drop logs -f`).
   *  v1: follows the FIRST READY pod only — no fan-out/multiplexing across replicas of a multi-pod
   *  app (documented behavior; a future console live-tail may fan out to N pods). Returns null if no
   *  pod can be found. The stream is the raw chunked response body; destroying it (or aborting
   *  `opts.signal`) must tear down the upstream connection so a client disconnect never leaks a
   *  socket. */
  getWorkloadLogsStream(namespace: string, name: string, opts?: { tailLines?: number; signal?: AbortSignal }): Promise<Readable | null>;
  /** Run a release Job (priors already GC'd by deleteReleaseJobs) and wait for it to terminally
   *  succeed or fail/timeout, bounded by `timeoutMs`. Returns the outcome + the tail of the release
   *  pod's logs. Never THROWS on Job failure — the deploy path halts on `ok:false` and surfaces logs. */
  runReleaseJob(namespace: string, name: string, job: Record<string, unknown>, timeoutMs: number): Promise<ReleaseResult>;
  /** Delete all release Jobs for an app (GC prior runs before a deploy; also on app delete). Safe if absent. */
  deleteReleaseJobs(namespace: string, name: string): Promise<void>;
  /** Latest release Job pod logs for an app (`drop logs --release`). "" if none. */
  getReleaseLogs(namespace: string, name: string, tailLines?: number): Promise<string>;
  /** Per-process live status: one row per process Deployment (web + workers), for `drop ps`. Empty if absent. */
  listAppProcesses(namespace: string, name: string): Promise<ProcessStatus[]>;
  /** Roll the app's pods (bump a pod-template annotation) — picks up new env/secrets. */
  restartApp(namespace: string, name: string, restartedAt: string): Promise<void>;
  /** Take the app TRULY offline: pause KEDA (pin to 0, ignore traffic) + scale the Deployment to 0. */
  stopApp(namespace: string, name: string): Promise<void>;
  /** Resume: un-pause KEDA so it scales per the HTTPScaledObject again. */
  startApp(namespace: string, name: string): Promise<void>;
  /** The tenant ResourceQuota's hard limits + current usage (drop-quota), or null if the namespace
   *  / quota isn't provisioned yet (e.g. a tenant with only static sites — no compute namespace). */
  getTenantUsage(namespace: string): Promise<TenantUsage | null>;
  /** CNPG Backup objects for a managed database (newest first). Empty if none / cluster absent. */
  listDatabaseBackups(namespace: string, name: string): Promise<BackupInfo[]>;
  /** Trigger an on-demand CNPG Backup (creates a Backup object via the Barman Cloud Plugin). */
  triggerDatabaseBackup(namespace: string, name: string, backupName: string): Promise<void>;
  /** Declarative hibernation: scale the CNPG cluster to zero (cnpg.io/hibernation=on). */
  hibernateDatabase(namespace: string, name: string): Promise<void>;
  /** Wake a hibernated CNPG cluster (cnpg.io/hibernation=off). */
  wakeDatabase(namespace: string, name: string): Promise<void>;
}

export interface BackupInfo {
  name: string;
  phase: string; // CNPG .status.phase: "completed" | "running" | "failed" | "started" | ...
  method: string | null; // "plugin" | "barmanObjectStore" | ...
  startedAt: string | null;
  stoppedAt: string | null;
  error: string | null;
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

/** Live status of ONE process Deployment (web or a worker) — an AppStatus plus its identity. */
export interface ProcessStatus extends AppStatus {
  name: string; // Deployment name: `<app>` for web, `<app>-<process>` for a worker
  process: string; // the process key ("web" for the implicit/web process)
  web: boolean; // gets the Service + HTTPScaledObject
}

/** Outcome of a release Job run (see runReleaseJob). `logs` is the tail of the release pod's output. */
export interface ReleaseResult {
  ok: boolean; // the Job succeeded
  reason: "succeeded" | "failed" | "timeout";
  logs: string;
}
export interface DatabaseStatus {
  phase: string; // CNPG .status.phase, e.g. "Cluster in healthy state"
  ready: number; // ready instances
  instances: number; // desired instances
  hibernated: boolean; // cnpg.io/hibernation=on (manually hibernated → scaled to zero)
}
