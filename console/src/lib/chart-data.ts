// (M4) Pure data-shaping helpers behind the metric charts + sparklines. Kept free of React/DOM/uPlot so
// they unit-test in isolation (chart-data.test.ts): the Chart wrapper (components/Chart.tsx) only turns
// these shapes into a uPlot instance, and the SVG sparkline consumes `sparklinePath` directly. uPlot
// itself is never exercised in tests (no canvas under happy-dom) — the transforms are.

import type { MetricsSeriesPoint, UptimeLastCheck } from "./api.ts";

// ---- number formatting (shared display, resilience detail) ------------------------------------------

/** Bytes → a compact binary-unit string (matches the old MetricsPanel: "1.2 MiB"). */
export function fmtBytes(n: number): string {
  const k = 1024;
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < k) return `${n} B`;
  if (n < k * k) return `${(n / k).toFixed(1)} KiB`;
  if (n < k * k * k) return `${(n / (k * k)).toFixed(1)} MiB`;
  return `${(n / (k * k * k)).toFixed(1)} GiB`;
}

/** Large counts → a compact "1.2k" / "3.4M" string; small counts stay exact. */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1000) return String(n);
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Milliseconds → "45ms" / "1.2s". */
export function fmtMs(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

/** A 0–100 percentage to one decimal, trimming a trailing ".0". */
export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}

// ---- range → rollup granularity (matches the G2 server buckets) -------------------------------------

export type Range = "1h" | "24h" | "7d";
export const RANGES: Range[] = ["1h", "24h", "7d"];

export interface RangeMeta {
  range: Range;
  label: string; // the picker label
  /** Nominal bucket width in seconds (1h→per-minute, 24h→hourly, 7d→~6h) — matches the G2 rollup. */
  bucketSec: number;
}

const RANGE_META: Record<Range, RangeMeta> = {
  "1h": { range: "1h", label: "1h", bucketSec: 60 },
  "24h": { range: "24h", label: "24h", bucketSec: 3600 },
  "7d": { range: "7d", label: "7d", bucketSec: 6 * 3600 },
};

export function rangeMeta(range: Range): RangeMeta {
  return RANGE_META[range] ?? RANGE_META["1h"];
}

// ---- series → uPlot AlignedData ---------------------------------------------------------------------

/** The metric a chart plots off a series point. */
export type MetricKey = "requests" | "p50" | "p95" | "errorRate" | "bytesOut";

/** Error rate as a 0–100 percentage for one point (0 when there was no traffic). Pure. */
export function errorRate(p: Pick<MetricsSeriesPoint, "requests" | "errors">): number {
  return p.requests > 0 ? (p.errors / p.requests) * 100 : 0;
}

/** Extract one metric's y-values from a series (aligned to `timestamps`). */
export function metricValues(series: MetricsSeriesPoint[], key: MetricKey): number[] {
  return series.map((p) => (key === "errorRate" ? errorRate(p) : p[key]));
}

/** X axis as unix SECONDS (uPlot's native time unit). `minute` is an ISO string per the G2 contract. */
export function timestamps(series: MetricsSeriesPoint[]): number[] {
  return series.map((p) => Math.floor(new Date(p.minute).getTime() / 1000));
}

/** uPlot's AlignedData: [xs, ...ys]. `keys` fixes the y-series order the Chart's `series` config mirrors. */
export type AlignedData = [number[], ...number[][]];

export function alignedData(series: MetricsSeriesPoint[], keys: MetricKey[]): AlignedData {
  return [timestamps(series), ...keys.map((k) => metricValues(series, k))];
}

/** True when a series carries at least one non-zero sample for `key` — the "has real data" gate that
 *  decides chart-vs-number fallback (an all-zero window shows the number, not an empty chart). Pure. */
export function hasSignal(series: MetricsSeriesPoint[], key: MetricKey): boolean {
  return series.some((p) => (key === "errorRate" ? errorRate(p) : p[key]) > 0);
}

// ---- hand-rolled SVG sparkline (list cards; no uPlot on the list page) -------------------------------

/** Build an SVG polyline `points`/path from a numeric series scaled into a `w`×`h` box (y inverted so
 *  larger values sit higher). A flat/degenerate series draws a mid-height line. Pure — the caller feeds
 *  the result to an <svg><path d=…>. `pad` insets the stroke so it isn't clipped at the box edge. */
export function sparklinePath(values: number[], w = 100, h = 24, pad = 1): string {
  if (values.length === 0) return "";
  const innerW = Math.max(1, w - pad * 2);
  const innerH = Math.max(1, h - pad * 2);
  if (values.length === 1) {
    const y = pad + innerH / 2;
    return `M${pad} ${round(y)} L${pad + innerW} ${round(y)}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1; // flat series → a straight mid-line
  const stepX = innerW / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + innerH - ((v - min) / span) * innerH;
    return `${round(x)} ${round(y)}`;
  });
  return `M${pts.join(" L")}`;
}

/** The same points closed into a filled area (baseline at the box bottom) for the area-fill under the
 *  spark line. Empty for a degenerate series (the caller then draws only the line). Pure. */
export function sparklineArea(values: number[], w = 100, h = 24, pad = 1): string {
  if (values.length < 2) return "";
  const line = sparklinePath(values, w, h, pad);
  if (!line) return "";
  const innerW = Math.max(1, w - pad * 2);
  const bottom = h - pad;
  return `${line} L${round(pad + innerW)} ${round(bottom)} L${round(pad)} ${round(bottom)} Z`;
}

const round = (n: number): number => Math.round(n * 100) / 100;

// ---- uptime strip (thin ok/fail timeline) -----------------------------------------------------------

export interface UptimeCell {
  ok: boolean;
  at: string;
  latencyMs: number;
  status: number;
}

/** Oldest→newest cells for the uptime strip: the G2b `checks` come newest-first, so this reverses them
 *  (left = oldest). `cap` bounds the strip width (most recent `cap` checks). Pure. */
export function uptimeCells(checks: UptimeLastCheck[], cap = 60): UptimeCell[] {
  return checks
    .slice(0, cap)
    .map((c) => ({ ok: c.ok, at: c.at, latencyMs: c.latencyMs, status: c.status }))
    .reverse();
}
