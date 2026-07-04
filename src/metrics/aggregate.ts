// Pure read-side helpers over the metrics rollups (G2 / G2b): range aggregation, the uptime summary,
// and the Prometheus text format. No DB, no clock of their own (callers pass `now`) — so every branch
// is table-testable. The store fetches raw minute rows; these shape them for the API surfaces.

/** One raw `traffic_minutes` row as the store hands it back (minute + counters for that minute). */
export interface MinuteRow {
  minute: string | Date;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  p50Ms: number;
  p95Ms: number;
  s2xx: number;
  s4xx: number;
  s5xx: number;
}

/** A minute row tagged with its host — the Prometheus scrape's per-site latest snapshot. */
export interface NamedMinuteRow extends MinuteRow {
  siteName: string;
}

export type MetricsRange = "1h" | "24h" | "7d";

/** One point of the aggregated series (a fixed-width time bucket). `errors` = 4xx + 5xx. */
export interface SeriesPoint {
  minute: string; // ISO, the bucket START
  requests: number;
  p50: number;
  p95: number;
  errors: number;
  bytesOut: number;
}

export interface TrafficTotals {
  requests: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  p50: number; // request-weighted across the window
  p95: number; // max across the window (conservative)
}

// Range → total window + the server-side aggregation bucket. 1h is minute-granular (raw passthrough);
// 24h rolls to 10-minute buckets; 7d rolls to hourly — keeping every response a bounded, chart-ready
// point count (≤ ~168) regardless of how many raw minute rows the range spans.
const RANGE: Record<MetricsRange, { windowMs: number; bucketMs: number }> = {
  "1h": { windowMs: 60 * 60_000, bucketMs: 60_000 },
  "24h": { windowMs: 24 * 60 * 60_000, bucketMs: 10 * 60_000 },
  "7d": { windowMs: 7 * 24 * 60 * 60_000, bucketMs: 60 * 60_000 },
};

/** Coerce a `?range=` query param to a known range (default 1h). */
export function parseRange(v: unknown): MetricsRange {
  return v === "24h" || v === "7d" ? v : "1h";
}

/** The lookback window for a range, in ms (the API turns this into a `since` timestamp). */
export function rangeWindowMs(range: MetricsRange): number {
  return RANGE[range].windowMs;
}

const ms = (m: string | Date): number => (m instanceof Date ? m.getTime() : new Date(m).getTime());

// A per-bucket fold: sums are additive, p95 is the max of the merged minutes, p50 is request-weighted
// (the same honest approximation the UPSERT uses — a true merged percentile is unrecoverable without
// retaining per-minute bucket counts). `wp50` accumulates the numerator of the weighted average.
interface Fold {
  start: number;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  errors: number;
  p95: number;
  wp50: number; // Σ(p50_i * requests_i)
}

function foldRow(f: Fold, r: MinuteRow): void {
  f.requests += r.requests;
  f.bytesIn += r.bytesIn;
  f.bytesOut += r.bytesOut;
  f.errors += r.s4xx + r.s5xx;
  f.p95 = Math.max(f.p95, r.p95Ms);
  f.wp50 += r.p50Ms * r.requests;
}

const weightedP50 = (numerator: number, requests: number): number => (requests > 0 ? Math.round(numerator / requests) : 0);

/** Bucket raw minute rows into the range's fixed-width points + compute window totals. Pure. */
export function aggregateSeries(rows: MinuteRow[], range: MetricsRange): { series: SeriesPoint[]; totals: TrafficTotals } {
  const bucketMs = RANGE[range].bucketMs;
  const byBucket = new Map<number, Fold>();
  const totals: Fold = { start: 0, requests: 0, bytesIn: 0, bytesOut: 0, errors: 0, p95: 0, wp50: 0 };
  for (const r of rows) {
    const start = Math.floor(ms(r.minute) / bucketMs) * bucketMs;
    let f = byBucket.get(start);
    if (!f) byBucket.set(start, (f = { start, requests: 0, bytesIn: 0, bytesOut: 0, errors: 0, p95: 0, wp50: 0 }));
    foldRow(f, r);
    foldRow(totals, r);
  }
  const series = [...byBucket.values()]
    .sort((a, b) => a.start - b.start)
    .map((f) => ({
      minute: new Date(f.start).toISOString(),
      requests: f.requests,
      p50: weightedP50(f.wp50, f.requests),
      p95: f.p95,
      errors: f.errors,
      bytesOut: f.bytesOut,
    }));
  return {
    series,
    totals: {
      requests: totals.requests,
      errors: totals.errors,
      bytesIn: totals.bytesIn,
      bytesOut: totals.bytesOut,
      p50: weightedP50(totals.wp50, totals.requests),
      p95: totals.p95,
    },
  };
}

// ---- uptime (G2b) ----------------------------------------------------------------------------

/** One raw `uptime_checks` row as the store hands it back. */
export interface UptimeRow {
  minute: string | Date;
  ok: boolean;
  latencyMs: number;
  status: number;
}

export interface LastCheck {
  ok: boolean;
  latencyMs: number;
  status: number;
  at: string; // ISO
}

export interface UptimeSummary {
  last24hPct: number | null; // % of checks OK in the last 24h; null when there were none
  lastCheck: LastCheck | null; // the most recent check overall (may predate the 24h window)
}

/** Summarize uptime rows into the detail-panel shape: last-24h OK %, plus the most recent check.
 *  Order-independent (scans for the max minute); `now` bounds the 24h window. Pure. */
export function summarizeUptime(rows: UptimeRow[], now: Date): UptimeSummary {
  const cutoff = now.getTime() - 24 * 60 * 60_000;
  let okIn24h = 0;
  let totalIn24h = 0;
  let latest: UptimeRow | null = null;
  for (const r of rows) {
    const t = ms(r.minute);
    if (t >= cutoff) {
      totalIn24h += 1;
      if (r.ok) okIn24h += 1;
    }
    if (!latest || t > ms(latest.minute)) latest = r;
  }
  return {
    last24hPct: totalIn24h > 0 ? Math.round((okIn24h / totalIn24h) * 1000) / 10 : null,
    lastCheck: latest ? { ok: latest.ok, latencyMs: latest.latencyMs, status: latest.status, at: new Date(ms(latest.minute)).toISOString() } : null,
  };
}

// ---- Prometheus text exposition --------------------------------------------------------------

const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Render the latest-per-site rows as Prometheus text (all gauges — each reflects the LAST flushed
 *  minute, not a live/monotonic counter; the API is not the meter, the edge is). Stable metric+label
 *  ordering for a clean scrape diff. */
export function formatPrometheus(rows: NamedMinuteRow[]): string {
  const lines: string[] = [];
  const block = (metric: string, help: string, value: (r: NamedMinuteRow) => number, labels: (r: NamedMinuteRow) => string = () => "") => {
    lines.push(`# HELP ${metric} ${help}`);
    lines.push(`# TYPE ${metric} gauge`);
    for (const r of rows) lines.push(`${metric}{site="${escapeLabel(r.siteName)}"${labels(r)}} ${value(r)}`);
  };
  block("drop_edge_requests", "Requests served for a site in the last flushed minute.", (r) => r.requests);
  block("drop_edge_bytes_out", "Response bytes served for a site in the last flushed minute.", (r) => r.bytesOut);
  block("drop_edge_bytes_in", "Request bytes received for a site in the last flushed minute.", (r) => r.bytesIn);
  block("drop_edge_p50_ms", "Approx p50 upstream latency (ms) for a site in the last flushed minute.", (r) => r.p50Ms);
  block("drop_edge_p95_ms", "Approx p95 upstream latency (ms) for a site in the last flushed minute.", (r) => r.p95Ms);
  // Status classes as one metric with a `class` label.
  lines.push("# HELP drop_edge_status Responses by status class for a site in the last flushed minute.");
  lines.push("# TYPE drop_edge_status gauge");
  for (const r of rows) {
    lines.push(`drop_edge_status{site="${escapeLabel(r.siteName)}",class="2xx"} ${r.s2xx}`);
    lines.push(`drop_edge_status{site="${escapeLabel(r.siteName)}",class="4xx"} ${r.s4xx}`);
    lines.push(`drop_edge_status{site="${escapeLabel(r.siteName)}",class="5xx"} ${r.s5xx}`);
  }
  return lines.join("\n") + "\n";
}
