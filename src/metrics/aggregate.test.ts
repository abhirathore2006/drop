import { test, expect } from "bun:test";
import { aggregateSeries, summarizeUptime, formatPrometheus, parseRange, rangeWindowMs, type MinuteRow, type UptimeRow } from "./aggregate.ts";

const row = (minute: string, over: Partial<MinuteRow> = {}): MinuteRow => ({
  minute,
  requests: 0,
  bytesIn: 0,
  bytesOut: 0,
  p50Ms: 0,
  p95Ms: 0,
  s2xx: 0,
  s4xx: 0,
  s5xx: 0,
  ...over,
});

test("parseRange: known values, else default 1h", () => {
  expect(parseRange("24h")).toBe("24h");
  expect(parseRange("7d")).toBe("7d");
  expect(parseRange("1h")).toBe("1h");
  expect(parseRange(undefined)).toBe("1h");
  expect(parseRange("bogus")).toBe("1h");
});

test("rangeWindowMs: 1h/24h/7d windows", () => {
  expect(rangeWindowMs("1h")).toBe(60 * 60_000);
  expect(rangeWindowMs("24h")).toBe(24 * 60 * 60_000);
  expect(rangeWindowMs("7d")).toBe(7 * 24 * 60 * 60_000);
});

test("aggregateSeries 1h: minute-granular passthrough, sorted", () => {
  const rows = [
    row("2026-07-04T10:02:00Z", { requests: 5, bytesOut: 50, p50Ms: 10, p95Ms: 40, s2xx: 5 }),
    row("2026-07-04T10:00:00Z", { requests: 3, bytesOut: 30, p50Ms: 20, p95Ms: 80, s2xx: 2, s4xx: 1 }),
  ];
  const { series, totals } = aggregateSeries(rows, "1h");
  expect(series.map((s) => s.minute)).toEqual(["2026-07-04T10:00:00.000Z", "2026-07-04T10:02:00.000Z"]);
  expect(series[0]!.requests).toBe(3);
  expect(series[0]!.errors).toBe(1);
  expect(totals.requests).toBe(8);
  expect(totals.errors).toBe(1);
  expect(totals.bytesOut).toBe(80);
});

test("aggregateSeries 24h: 10-min buckets, additive sums + weighted p50 + max p95", () => {
  const rows = [
    row("2026-07-04T10:00:00Z", { requests: 10, bytesOut: 100, p50Ms: 20, p95Ms: 100, s2xx: 9, s4xx: 1 }),
    row("2026-07-04T10:05:00Z", { requests: 30, bytesOut: 300, p50Ms: 40, p95Ms: 200, s2xx: 25, s5xx: 5 }),
    row("2026-07-04T10:15:00Z", { requests: 4, bytesOut: 40, p50Ms: 10, p95Ms: 25, s2xx: 4 }),
  ];
  const { series, totals } = aggregateSeries(rows, "24h");
  expect(series).toHaveLength(2); // 10:00 + 10:05 fold into the 10:00 bucket; 10:15 is its own
  const b0 = series[0]!;
  expect(b0.minute).toBe("2026-07-04T10:00:00.000Z");
  expect(b0.requests).toBe(40);
  expect(b0.p95).toBe(200); // max(100,200)
  expect(b0.p50).toBe(35); // (20*10 + 40*30)/40
  expect(b0.errors).toBe(6);
  expect(b0.bytesOut).toBe(400);
  expect(totals.requests).toBe(44);
  expect(totals.p95).toBe(200);
  expect(totals.errors).toBe(6);
});

test("aggregateSeries: empty rows → empty series + zeroed totals", () => {
  const { series, totals } = aggregateSeries([], "1h");
  expect(series).toEqual([]);
  expect(totals).toEqual({ requests: 0, errors: 0, bytesIn: 0, bytesOut: 0, p50: 0, p95: 0 });
});

const urow = (minute: string, ok: boolean, latencyMs = 0, status = 0): UptimeRow => ({ minute, ok, latencyMs, status });

test("summarizeUptime: last-24h % + the most recent check", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  const s = summarizeUptime(
    [urow("2026-07-04T11:00:00Z", true, 40, 200), urow("2026-07-04T11:30:00Z", false, 0, 502), urow("2026-07-04T11:59:00Z", true, 50, 200)],
    now,
  );
  expect(s.last24hPct).toBe(66.7); // 2 of 3 OK
  expect(s.lastCheck).toEqual({ ok: true, latencyMs: 50, status: 200, at: "2026-07-04T11:59:00.000Z" });
});

test("summarizeUptime: no rows → nulls", () => {
  expect(summarizeUptime([], new Date())).toEqual({ last24hPct: null, lastCheck: null });
});

test("summarizeUptime: a check older than 24h has no %, but is still the lastCheck", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  const s = summarizeUptime([urow("2026-07-01T00:00:00Z", true, 30, 200)], now);
  expect(s.last24hPct).toBeNull();
  expect(s.lastCheck?.at).toBe("2026-07-01T00:00:00.000Z");
});

test("formatPrometheus: gauges with site + status-class labels", () => {
  const text = formatPrometheus([
    { siteName: "myapp", minute: "2026-07-04T10:00:00Z", requests: 42, bytesIn: 10, bytesOut: 999, p50Ms: 5, p95Ms: 50, s2xx: 40, s4xx: 1, s5xx: 1 },
  ]);
  expect(text).toContain("# TYPE drop_edge_requests gauge");
  expect(text).toContain('drop_edge_requests{site="myapp"} 42');
  expect(text).toContain('drop_edge_bytes_out{site="myapp"} 999');
  expect(text).toContain('drop_edge_p95_ms{site="myapp"} 50');
  expect(text).toContain('drop_edge_status{site="myapp",class="5xx"} 1');
  expect(text.endsWith("\n")).toBe(true);
});
