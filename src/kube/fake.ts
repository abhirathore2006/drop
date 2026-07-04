import { Readable } from "node:stream";
import {
  PasswordSyncError,
  type KubeClient,
  type AppStatus,
  type DatabaseStatus,
  type TenantUsage,
  type BackupInfo,
  type ProcessStatus,
  type ReleaseResult,
} from "./types.ts";
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

  // (A2b) edge-tcp Service port-list patches — tests assert what listeners the NLB would be told to run.
  readonly edgeTcpPortPatches: { namespace: string; service: string; ports: { name: string; port: number }[] }[] = [];
  async patchEdgeTcpPorts(namespace: string, service: string, ports: { name: string; port: number }[]): Promise<void> {
    this.edgeTcpPortPatches.push({ namespace, service, ports });
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

  readonly passwordSets: { namespace: string; name: string; password: string }[] = [];
  passwordGate: Promise<void> | null = null; // tests can hold a rotation in-flight (concurrency)
  passwordSyncFail = false; // tests can simulate "role rotated but Secret write failed"
  async setDatabasePassword(namespace: string, name: string, newPassword: string): Promise<void> {
    if (!this.dbs.has(this.key(namespace, name))) throw new Error(`no such database: ${name}`);
    if (this.passwordGate) await this.passwordGate;
    this.passwordSets.push({ namespace, name, password: newPassword }); // the role IS rotated
    if (this.passwordSyncFail) throw new PasswordSyncError(`${name}: rotated but creds Secret not synced`);
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
    return this.dbs.has(k) ? { phase: "Cluster in healthy state", ready: 1, instances: 1, hibernated: this.hibernated.has(k) } : null;
  }

  // Aggregated namespace status lists (C1): reuse the per-workload doubles, scoped to one namespace.
  private inNs(k: string, namespace: string): string | null {
    const i = k.indexOf("/");
    return k.slice(0, i) === namespace ? k.slice(i + 1) : null;
  }
  async listNamespaceAppStatuses(namespace: string): Promise<Record<string, AppStatus>> {
    const out: Record<string, AppStatus> = {};
    for (const k of this.apps.keys()) {
      const name = this.inNs(k, namespace);
      if (name) out[name] = (await this.getAppStatus(namespace, name))!;
    }
    return out;
  }
  async listNamespaceDatabaseStatuses(namespace: string): Promise<Record<string, DatabaseStatus>> {
    const out: Record<string, DatabaseStatus> = {};
    for (const k of this.dbs) {
      const name = this.inNs(k, namespace);
      if (name) out[name] = (await this.getDatabaseStatus(namespace, name))!;
    }
    return out;
  }

  // CNPG backups + declarative hibernation doubles.
  readonly backupsByDb = new Map<string, BackupInfo[]>(); // tests can preset a backup history
  readonly backupTriggers: { namespace: string; name: string; backupName: string }[] = [];
  readonly hibernated = new Set<string>();
  async listDatabaseBackups(namespace: string, name: string): Promise<BackupInfo[]> {
    return this.backupsByDb.get(this.key(namespace, name)) ?? [];
  }
  async triggerDatabaseBackup(namespace: string, name: string, backupName: string): Promise<void> {
    if (!this.dbs.has(this.key(namespace, name))) throw new Error(`no such database: ${name}`);
    this.backupTriggers.push({ namespace, name, backupName });
  }
  async hibernateDatabase(namespace: string, name: string): Promise<void> {
    if (!this.dbs.has(this.key(namespace, name))) throw new Error(`no such database: ${name}`);
    this.hibernated.add(this.key(namespace, name));
  }
  async wakeDatabase(namespace: string, name: string): Promise<void> {
    if (!this.dbs.has(this.key(namespace, name))) throw new Error(`no such database: ${name}`);
    this.hibernated.delete(this.key(namespace, name));
  }

  readonly logsByName = new Map<string, string>();
  async getWorkloadLogs(namespace: string, name: string): Promise<string> {
    return this.logsByName.get(this.key(namespace, name)) ?? "";
  }

  // Scriptable follow-log streams (G1): tests preset the lines a `getWorkloadLogsStream` call should
  // emit for a given namespace/name, keyed the same way as the other doubles. `keepOpen: true` holds
  // the stream open after emitting its scripted lines (nothing further is pushed) so a test can
  // exercise the abort path; otherwise the stream ends (push(null)) once the lines are drained.
  readonly scriptedLogStreams = new Map<string, { lines: string[]; keepOpen?: boolean }>();
  // Recorded whenever `opts.signal` fires — lets a test assert the "upstream" stream was torn down.
  readonly logStreamAborts: { namespace: string; name: string }[] = [];
  async getWorkloadLogsStream(namespace: string, name: string, opts: { tailLines?: number; signal?: AbortSignal } = {}): Promise<Readable | null> {
    const script = this.scriptedLogStreams.get(this.key(namespace, name));
    if (!script) return null;
    let i = 0;
    let ended = false;
    const stream = new Readable({
      read() {
        if (ended) return;
        if (i < script.lines.length) this.push(Buffer.from(script.lines[i++] + "\n"));
        else if (!script.keepOpen) {
          ended = true;
          this.push(null);
        }
        // keepOpen && fully drained: push nothing more — the stream just stays open until destroyed.
      },
    });
    if (opts.signal) {
      const onAbort = () => {
        this.logStreamAborts.push({ namespace, name });
        stream.destroy();
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    return stream;
  }

  // Release-Job doubles. Tests SCRIPT the next release outcome by pushing onto `scriptedReleases`
  // (FIFO); an unscripted run succeeds with whatever `releaseLogs` holds. Every run/GC is recorded.
  scriptedReleases: ReleaseResult[] = [];
  readonly releaseLogs = new Map<string, string>();
  readonly releaseRuns: { namespace: string; name: string; job: Record<string, unknown> }[] = [];
  readonly releaseJobDeletes: { namespace: string; name: string }[] = [];
  async runReleaseJob(namespace: string, name: string, job: Record<string, unknown>, _timeoutMs: number): Promise<ReleaseResult> {
    this.releaseRuns.push({ namespace, name, job });
    return this.scriptedReleases.shift() ?? { ok: true, reason: "succeeded", logs: this.releaseLogs.get(this.key(namespace, name)) ?? "" };
  }
  async deleteReleaseJobs(namespace: string, name: string): Promise<void> {
    this.releaseJobDeletes.push({ namespace, name });
  }
  async getReleaseLogs(namespace: string, name: string): Promise<string> {
    return this.releaseLogs.get(this.key(namespace, name)) ?? "";
  }

  // Per-process status, derived from the applied manifests: the web Deployment (if any) + each
  // worker. Honors statusOverride keyed by the DEPLOYMENT name, else a healthy default.
  async listAppProcesses(namespace: string, name: string): Promise<ProcessStatus[]> {
    const m = this.apps.get(this.key(namespace, name));
    if (!m) return [];
    const row = (dn: string, process: string, web: boolean): ProcessStatus => {
      const ov = this.statusOverride.get(this.key(namespace, dn)) as AppStatus | undefined;
      return { ...(ov ?? { replicas: 1, ready: 1, restarts: 0, reason: "Running" }), name: dn, process, web };
    };
    const out: ProcessStatus[] = [];
    if (m.deployment) out.push(row(name, "web", true));
    for (const w of m.workers ?? []) out.push(row(w.name, w.process, false));
    return out;
  }

  readonly restarts: { namespace: string; name: string }[] = [];
  readonly stopped = new Set<string>();
  async restartApp(namespace: string, name: string): Promise<void> {
    this.restarts.push({ namespace, name });
  }
  async stopApp(namespace: string, name: string): Promise<void> {
    this.stopped.add(this.key(namespace, name));
    // (H2) Mirror the real client: stopping a cron app suspends its CronJob (spec.suspend), not just
    // the generic `stopped` bookkeeping — so a test can assert on the manifest directly.
    const cronJob = this.apps.get(this.key(namespace, name))?.cronJob as { spec?: { suspend?: boolean } } | undefined;
    if (cronJob) (cronJob.spec ??= {}).suspend = true;
  }
  async startApp(namespace: string, name: string): Promise<void> {
    this.stopped.delete(this.key(namespace, name));
    const cronJob = this.apps.get(this.key(namespace, name))?.cronJob as { spec?: { suspend?: boolean } } | undefined;
    if (cronJob) (cronJob.spec ??= {}).suspend = false;
  }

  // Tests can preset a usage report per namespace; otherwise a namespace that has had a tenant
  // applied reports the default quota with zero usage, and an unknown namespace reports null.
  readonly usageByNs = new Map<string, TenantUsage>();
  async getTenantUsage(namespace: string): Promise<TenantUsage | null> {
    if (this.usageByNs.has(namespace)) return this.usageByNs.get(namespace)!;
    if (this.tenantApplies.some((t) => t.namespace === namespace))
      return { hard: { "limits.cpu": "4", "limits.memory": "8Gi", "count/pods": "20" }, used: { "limits.cpu": "0", "limits.memory": "0", "count/pods": "0" } };
    return null;
  }
}
