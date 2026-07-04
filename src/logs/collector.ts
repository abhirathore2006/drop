// (G4) Searchable-log COLLECTOR. Sidecar-free, deliberately not-Loki: the API tails each RUNNING
// workload's pod logs (ONE follow stream per workload — v1 follows the first ready pod, exactly as the
// G1 live-tail does), batches structured lines into in-memory hour buckets, and flushes each bucket as a
// gzipped NDJSON object `logs/<site>/<hour>.ndjson.gz` in S3 (which the platform already owns) plus a
// `log_objects` index row per object.
//
// Fan-out is BOUNDED on three axes so this never becomes a fleet-wide firehose:
//   • only RUNNING workloads that opt in (metastore query — shouldCollectLogs; databases are OFF by
//     default, apps/sites ON with an opt-out),
//   • a cap on concurrent tails (maxConcurrentTails),
//   • a per-(site,hour) in-memory line cap (maxLinesPerHour — a ring that drops the oldest under flood).
//
// Posture is AT-LEAST-ONCE, best-effort: on a collector restart a tail resumes from the last line's
// timestamp (`sinceTime`) so it doesn't re-ingest the whole backlog, but a few lines either side of the
// boundary may duplicate — dedup is deliberately NOT attempted (grep-grade history doesn't need it).
//
// bin/api.ts drives two ticks on the housekeeping loop: reconcile() (start/stop tails) and flush() (write
// dirty buckets to S3 + index). Both are separate public methods so tests can step them deterministically.
import type { Readable } from "node:stream";
import type { BlobStore } from "../blob/types.ts";
import type { KubeClient } from "../kube/types.ts";
import type { MetaStore } from "../metastore/store.ts";
import { hourStart, logObjectKey, serializeNdjsonGz, type LogRecord } from "./format.ts";

/** DBs are EXCLUDED by default (their logs are verbose AND can echo query text/params) — opt in with
 *  `database.log_retention: true`. Apps/sites are collected by default; opt OUT with `app.log_retention:
 *  false`. This is the simpler of the two knobs the plan floated (a per-resource default + a single
 *  boolean override) — no separate sanitizer stage, one flag reused across both configs. */
export function shouldCollectLogs(type: string, logRetention?: boolean): boolean {
  if (type === "database") return logRetention === true; // opt-in
  return logRetention !== false; // apps/sites default on; explicit false opts out
}

interface HourBucket {
  records: LogRecord[];
  dirty: boolean; // received records since the last successful flush → needs a (re)write
  truncated: boolean; // the ring dropped lines this hour (flood) — surfaced in the flush log
}

interface Tail {
  name: string;
  namespace: string;
  abort: AbortController;
  carry: string; // incomplete trailing line between stream chunks
}

export interface LogCollectorOptions {
  meta: MetaStore;
  kube: KubeClient;
  blob: BlobStore;
  maxConcurrentTails?: number; // default 50
  maxLinesPerHour?: number; // per-(site,hour) in-memory ring cap; default 20000
  initialTailLines?: number; // backlog to grab when a workload is first tailed; default 100
  now?: () => Date;
  log?: (msg: string) => void;
}

export class LogCollector {
  private readonly meta: MetaStore;
  private readonly kube: KubeClient;
  private readonly blob: BlobStore;
  private readonly maxConcurrentTails: number;
  private readonly maxLinesPerHour: number;
  private readonly initialTailLines: number;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  // site name → its hour buckets (keyed by hour-start epoch ms).
  private readonly buffers = new Map<string, Map<number, HourBucket>>();
  // site name → its active follow stream. Keyed by workload name (unique across types).
  private readonly tails = new Map<string, Tail>();
  // site name → the timestamp of the last line we ingested — the `sinceTime` a restarted tail resumes from.
  private readonly lastSeen = new Map<string, string>();
  // In-flight pump promises — so tests can deterministically await a finite scripted stream draining.
  private readonly pumps = new Set<Promise<void>>();

  constructor(o: LogCollectorOptions) {
    this.meta = o.meta;
    this.kube = o.kube;
    this.blob = o.blob;
    this.maxConcurrentTails = o.maxConcurrentTails ?? 50;
    this.maxLinesPerHour = o.maxLinesPerHour ?? 20_000;
    this.initialTailLines = o.initialTailLines ?? 100;
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? (() => {});
  }

  /** Buffer one line into its (site, hour) bucket. Pure/synchronous — the pump calls it per line, and
   *  tests call it directly to exercise batching without a live stream. `at` defaults to now(). */
  ingest(site: string, pod: string, stream: "stdout" | "stderr", line: string, at: Date = this.now()): void {
    const ts = at.toISOString();
    const hour = hourStart(at).getTime();
    let byHour = this.buffers.get(site);
    if (!byHour) this.buffers.set(site, (byHour = new Map()));
    let bucket = byHour.get(hour);
    if (!bucket) byHour.set(hour, (bucket = { records: [], dirty: false, truncated: false }));
    bucket.records.push({ ts, site, pod, stream, line });
    // Bound memory: a pathological chatty pod can't grow one hour without limit — drop the OLDEST line
    // (ring) and mark the hour truncated. At-least-once already forgives loss, so this is safe.
    if (bucket.records.length > this.maxLinesPerHour) {
      bucket.records.shift();
      bucket.truncated = true;
    }
    bucket.dirty = true;
    this.lastSeen.set(site, ts);
  }

  /** Start/stop follow streams to match the current set of running, opted-in workloads. Bounded by
   *  maxConcurrentTails. Called on the housekeeping tick; safe to call repeatedly (idempotent). */
  async reconcile(): Promise<void> {
    const targets = (await this.meta.listLogCollectionTargets()).filter((t) => shouldCollectLogs(t.type, t.logRetention));
    const wanted = new Set(targets.map((t) => t.name));
    // Stop tails whose workload stopped/was deleted/opted out.
    for (const [name, tail] of this.tails) {
      if (!wanted.has(name)) {
        tail.abort.abort();
        this.tails.delete(name);
      }
    }
    // Start tails for newly-running targets, up to the concurrency cap.
    for (const t of targets) {
      if (this.tails.size >= this.maxConcurrentTails) break;
      if (this.tails.has(t.name)) continue;
      await this.startTail(t.name, t.namespace);
    }
  }

  /** Open one follow stream for a workload and pump it into the buffer. Resumes from the last-seen
   *  timestamp when we've tailed this workload before (restart-safe); otherwise grabs a small backlog. */
  private async startTail(name: string, namespace: string): Promise<void> {
    const abort = new AbortController();
    const since = this.lastSeen.get(name);
    const stream = await this.kube
      .getWorkloadLogsStream(namespace, name, since ? { sinceTime: since, signal: abort.signal } : { tailLines: this.initialTailLines, signal: abort.signal })
      .catch(() => null);
    if (!stream) return; // no ready pod yet — the next reconcile retries (nothing recorded)
    const tail: Tail = { name, namespace, abort, carry: "" };
    this.tails.set(name, tail);
    const p = this.pump(tail, stream).finally(() => this.pumps.delete(p));
    this.pumps.add(p);
  }

  /** Test hook: resolve once every in-flight pump has drained (a finite scripted stream reaches its end). */
  async idle(): Promise<void> {
    await Promise.all([...this.pumps]);
  }

  /** Read a follow stream to its end, ingesting complete lines. On end (pod rotated/gone) the tail is
   *  dropped so the next reconcile re-opens it from `sinceTime`. Never throws — a torn stream just ends. */
  private async pump(tail: Tail, stream: Readable): Promise<void> {
    try {
      for await (const chunk of stream) {
        const combined = tail.carry + Buffer.from(chunk).toString("utf8");
        const parts = combined.split("\n");
        tail.carry = parts.pop() ?? "";
        const at = this.now();
        for (const line of parts) this.ingest(tail.name, tail.name, "stdout", line, at);
      }
      if (tail.carry) this.ingest(tail.name, tail.name, "stdout", tail.carry, this.now());
    } catch {
      /* aborted or a torn connection — treat as end-of-stream */
    } finally {
      // Only drop it if it's still the CURRENT tail (reconcile may already have replaced/removed it).
      if (this.tails.get(tail.name) === tail) this.tails.delete(tail.name);
    }
  }

  /** Write every dirty hour bucket to S3 (overwriting that hour's object with its full accumulated set)
   *  and upsert its index row. Evicts fully-flushed past-hour buckets so memory stays bounded to roughly
   *  the current hour. Best-effort: a per-object failure logs and leaves the bucket dirty to retry. */
  async flush(): Promise<number> {
    const currentHour = hourStart(this.now()).getTime();
    let written = 0;
    for (const [site, byHour] of this.buffers) {
      for (const [hourMs, bucket] of byHour) {
        if (bucket.dirty && bucket.records.length > 0) {
          const hour = new Date(hourMs);
          const key = logObjectKey(site, hour);
          const bytes = serializeNdjsonGz(bucket.records);
          try {
            // ONE object per (site, hour): each flush REWRITES it with the hour's full accumulated set, so
            // the index counts (lines/bytes) always describe the object as it now stands on disk.
            await this.blob.put(key, bytes, bytes.byteLength, "application/gzip");
            await this.meta.insertLogObject({ siteName: site, hour, key, lines: bucket.records.length, bytes: bytes.byteLength });
            bucket.dirty = false;
            written++;
            if (bucket.truncated) this.log(`log collector: ${site} ${key} truncated (hour exceeded ${this.maxLinesPerHour} lines)`);
          } catch (e) {
            this.log(`log collector: flush ${key} failed: ${(e as Error).message}`); // stays dirty → retried next tick
          }
        }
        // Evict a past hour once it's been flushed (not dirty) — its object is complete on disk.
        if (hourMs < currentHour && !bucket.dirty) byHour.delete(hourMs);
      }
      if (byHour.size === 0) this.buffers.delete(site);
    }
    return written;
  }

  /** Abort every tail (process shutdown / test cleanup). */
  stop(): void {
    for (const tail of this.tails.values()) tail.abort.abort();
    this.tails.clear();
  }

  /** Test/introspection: names of currently-active tails. */
  activeTails(): string[] {
    return [...this.tails.keys()].sort();
  }
}
