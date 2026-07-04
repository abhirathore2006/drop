// In-process edge traffic collector (G2). The edge (and edge-tcp) accumulate per-host counters here
// and `flush()` them every ~15s into `traffic_minutes` (see MetricsStore). Deliberately pure and
// dependency-free: no clock, no DB, no I/O — the caller supplies the flush timestamp and persists the
// returned rows, so this file is exhaustively table-testable (record/flush/reset, bucket percentiles,
// stream folding) without a database or a fake edge.

/** Fixed upper-bound histogram buckets in milliseconds (G2). A latency `ms` lands in the FIRST bucket
 *  whose bound it does not exceed; anything above the last bound lands in the implicit overflow bucket
 *  (index === BUCKETS.length). p50/p95 are approximated from these bounds at flush — never a true
 *  quantile (we don't retain per-request samples), which is the honest tradeoff of a one-row/min table. */
export const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

/** One HTTP response the edge served, as seen at the point where status + bytes + latency are known. */
export interface RecordInput {
  status: number; // final HTTP status (2xx/3xx/4xx/5xx — 401/403 denials included)
  bytesIn: number; // request body bytes (uploads); 0 when unknown
  bytesOut: number; // response body bytes; 0 when a streamed body carries no content-length
  ms: number; // wall time to produce the response (upstream latency for a proxied app; serve time for a static asset)
}

/** One closed WS/TCP stream (G2). `durationMs` is the whole connection lifetime — deliberately NOT
 *  folded into the request-latency histogram (a long-lived socket would corrupt p50/p95 into a
 *  connection-lifetime metric); a stream contributes ONLY to the request COUNT + byte totals. The
 *  field is kept in the signature because the edge-tcp `onClose` seam supplies it (and a future
 *  avg-connection column could consume it), but the collector intentionally ignores it. */
export interface StreamInput {
  bytesIn: number;
  bytesOut: number;
  durationMs?: number;
}

/** One flushed rollup row (host + counters for the flush window). The caller stamps `minute` + persists. */
export interface TrafficRow {
  siteName: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  p50Ms: number;
  p95Ms: number;
  s2xx: number;
  s4xx: number;
  s5xx: number;
}

interface HostAcc {
  requests: number;
  bytesIn: number;
  bytesOut: number;
  s2xx: number;
  s4xx: number;
  s5xx: number;
  // Histogram counts: LATENCY_BUCKETS.length + 1 slots (the last is the >last-bound overflow bucket).
  hist: number[];
}

function newAcc(): HostAcc {
  return { requests: 0, bytesIn: 0, bytesOut: 0, s2xx: 0, s4xx: 0, s5xx: 0, hist: new Array(LATENCY_BUCKETS.length + 1).fill(0) };
}

/** Index of the histogram bucket a latency lands in: the first bound it does not exceed, else overflow. */
function bucketIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) if (ms <= LATENCY_BUCKETS[i]!) return i;
  return LATENCY_BUCKETS.length; // overflow (> last bound)
}

/** Approximate a quantile from bucket counts: walk the cumulative distribution and return the UPPER
 *  bound of the bucket that crosses `q`. Systematically rounds UP (conservative — better to over-state
 *  latency than under-state it); the overflow bucket reports the last finite bound as a ceiling. Zero
 *  samples → 0. Pure + exported for direct table-testing. */
export function percentileFromBuckets(hist: readonly number[], q: number): number {
  let total = 0;
  for (const c of hist) total += c;
  if (total === 0) return 0;
  const target = Math.ceil(q * total);
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    cum += hist[i]!;
    if (cum >= target) return LATENCY_BUCKETS[Math.min(i, LATENCY_BUCKETS.length - 1)]!;
  }
  return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1]!;
}

/** The edge's per-host traffic accumulator. `record`/`recordStream` fold into a live map; `flush`
 *  snapshots + RESETS it, returning one TrafficRow per host that saw activity this window. */
export class Collector {
  private hosts = new Map<string, HostAcc>();

  private acc(host: string): HostAcc {
    let a = this.hosts.get(host);
    if (!a) this.hosts.set(host, (a = newAcc()));
    return a;
  }

  /** Meter one served/proxied HTTP response, keyed by the resolved serving host (site or `site--label`). */
  record(host: string, r: RecordInput): void {
    if (!host) return;
    const a = this.acc(host);
    a.requests += 1;
    a.bytesIn += Math.max(0, r.bytesIn | 0);
    a.bytesOut += Math.max(0, r.bytesOut | 0);
    if (r.status >= 200 && r.status < 300) a.s2xx += 1;
    else if (r.status >= 400 && r.status < 500) a.s4xx += 1;
    else if (r.status >= 500 && r.status < 600) a.s5xx += 1;
    // 1xx/3xx count toward `requests` + bytes but not toward any error/success class (by design).
    a.hist[bucketIndex(Math.max(0, r.ms))] += 1;
  }

  /** Meter one closed WS/TCP stream, keyed by the resolved workload. Folds into the SAME host row as
   *  HTTP (`requests += 1`, bytes add); `durationMs` is intentionally not histogrammed (see StreamInput). */
  recordStream(host: string, s: StreamInput): void {
    if (!host) return;
    const a = this.acc(host);
    a.requests += 1;
    a.bytesIn += Math.max(0, s.bytesIn | 0);
    a.bytesOut += Math.max(0, s.bytesOut | 0);
  }

  /** Number of hosts with pending (un-flushed) activity — lets the flush loop skip an empty DB round-trip. */
  size(): number {
    return this.hosts.size;
  }

  /** Snapshot every active host into a TrafficRow[] and RESET the accumulator. The caller stamps the
   *  flush `minute` + UPSERTs. Percentiles are approximated from the window's buckets right here. */
  flush(): TrafficRow[] {
    const rows: TrafficRow[] = [];
    for (const [siteName, a] of this.hosts) {
      rows.push({
        siteName,
        requests: a.requests,
        bytesIn: a.bytesIn,
        bytesOut: a.bytesOut,
        p50Ms: percentileFromBuckets(a.hist, 0.5),
        p95Ms: percentileFromBuckets(a.hist, 0.95),
        s2xx: a.s2xx,
        s4xx: a.s4xx,
        s5xx: a.s5xx,
      });
    }
    this.hosts.clear();
    return rows;
  }
}
