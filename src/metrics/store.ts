// The metastore seam for the G2/G2b rollups. Writers: the edge + edge-tcp flush loops (traffic) and
// the API uptime poller (uptime). Readers: the metrics/uptime API routes, the site-detail response,
// the Prometheus scrape, and the retention sweep. Kept thin — all the interesting logic (percentile
// approximation, range bucketing) is pure and lives in collector.ts / aggregate.ts.
import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import type { TrafficRow } from "./collector.ts";
import type { NamedMinuteRow, UptimeRow } from "./aggregate.ts";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const num = (v: unknown): number => Number(v ?? 0);

function toNamed(r: Record<string, unknown>): NamedMinuteRow {
  return {
    siteName: r.site_name as string,
    minute: iso(r.minute),
    requests: num(r.requests),
    bytesIn: num(r.bytes_in),
    bytesOut: num(r.bytes_out),
    p50Ms: num(r.p50_ms),
    p95Ms: num(r.p95_ms),
    s2xx: num(r.s2xx),
    s4xx: num(r.s4xx),
    s5xx: num(r.s5xx),
  };
}

export class MetricsStore {
  constructor(private db: Db) {}

  // ---- traffic (G2) --------------------------------------------------------------------------

  /** Persist one flush window's rows, stamped at `minute`, with an ADDITIVE UPSERT on (site_name,
   *  minute). Because ~4 flushes land in the same minute (15s loop), and multiple edge replicas write
   *  concurrently, the merge must be commutative + honest about what it CAN'T recover:
   *   - requests / bytes / status-class counts → summed (exact).
   *   - p95 → max(existing, new): conservative — a true merged p95 needs the raw buckets we didn't keep.
   *   - p50 → request-WEIGHTED average of the two windows' p50 approximations. Also not a true merged
   *     percentile (again, buckets aren't retained) but far better than a plain max/overwrite. This
   *     weighting is the documented accuracy tradeoff of a one-row-per-minute table (see docs/observability). */
  async flushTraffic(minute: Date, rows: TrafficRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insertInto("traffic_minutes")
      .values(
        rows.map((r) => ({
          site_name: r.siteName,
          minute,
          requests: r.requests,
          bytes_in: r.bytesIn,
          bytes_out: r.bytesOut,
          p50_ms: r.p50Ms,
          p95_ms: r.p95Ms,
          s2xx: r.s2xx,
          s4xx: r.s4xx,
          s5xx: r.s5xx,
        })),
      )
      .onConflict((oc) =>
        oc.columns(["site_name", "minute"]).doUpdateSet({
          requests: sql`traffic_minutes.requests + excluded.requests`,
          bytes_in: sql`traffic_minutes.bytes_in + excluded.bytes_in`,
          bytes_out: sql`traffic_minutes.bytes_out + excluded.bytes_out`,
          s2xx: sql`traffic_minutes.s2xx + excluded.s2xx`,
          s4xx: sql`traffic_minutes.s4xx + excluded.s4xx`,
          s5xx: sql`traffic_minutes.s5xx + excluded.s5xx`,
          p95_ms: sql`greatest(traffic_minutes.p95_ms, excluded.p95_ms)`,
          p50_ms: sql`case when (traffic_minutes.requests + excluded.requests) > 0
            then round((traffic_minutes.p50_ms::numeric * traffic_minutes.requests + excluded.p50_ms::numeric * excluded.requests)
                       / (traffic_minutes.requests + excluded.requests))::int
            else 0 end`,
        }),
      )
      .execute();
  }

  /** Every minute row for a site since `since`, oldest first — feeds aggregateSeries (range routes). */
  async trafficSeries(siteName: string, since: Date): Promise<NamedMinuteRow[]> {
    const rows = await this.db
      .selectFrom("traffic_minutes")
      .selectAll()
      .where("site_name", "=", siteName)
      .where("minute", ">=", since)
      .orderBy("minute", "asc")
      .execute();
    return rows.map((r) => toNamed(r as Record<string, unknown>));
  }

  /** The newest minute row per site within a recent window — the Prometheus scrape's snapshot (the
   *  LAST flushed minute per site, not a live counter). `since` bounds it so long-dead sites drop off. */
  async latestTrafficPerSite(since: Date): Promise<NamedMinuteRow[]> {
    const rows = await this.db
      .selectFrom("traffic_minutes")
      .selectAll()
      .where("minute", ">=", since)
      .distinctOn("site_name")
      .orderBy("site_name")
      .orderBy("minute", "desc")
      .execute();
    return rows.map((r) => toNamed(r as Record<string, unknown>));
  }

  /** Retention sweep: delete traffic rows older than `before`. Returns the deleted-row count. */
  async sweepTraffic(before: Date): Promise<number> {
    const res = await this.db.deleteFrom("traffic_minutes").where("minute", "<", before).executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n);
  }

  // ---- uptime (G2b) --------------------------------------------------------------------------

  /** Record one probe outcome (last-write-wins on the minute bucket). `status` is the HTTP status, or
   *  0 for a TCP-connect probe. */
  async recordUptime(siteName: string, minute: Date, r: { ok: boolean; latencyMs: number; status: number }): Promise<void> {
    await this.db
      .insertInto("uptime_checks")
      .values({ site_name: siteName, minute, ok: r.ok, latency_ms: r.latencyMs, status: r.status })
      .onConflict((oc) => oc.columns(["site_name", "minute"]).doUpdateSet({ ok: r.ok, latency_ms: r.latencyMs, status: r.status }))
      .execute();
  }

  /** Uptime checks for a site since `since`, oldest first — the strip endpoint + the detail summary. */
  async uptimeSince(siteName: string, since: Date): Promise<UptimeRow[]> {
    const rows = await this.db
      .selectFrom("uptime_checks")
      .selectAll()
      .where("site_name", "=", siteName)
      .where("minute", ">=", since)
      .orderBy("minute", "asc")
      .execute();
    return rows.map((r) => ({ minute: iso(r.minute), ok: r.ok as boolean, latencyMs: num(r.latency_ms), status: num(r.status) }));
  }

  /** Retention sweep: delete uptime rows older than `before`. Returns the deleted-row count. */
  async sweepUptime(before: Date): Promise<number> {
    const res = await this.db.deleteFrom("uptime_checks").where("minute", "<", before).executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n);
  }
}
