// (G2 / G2b → M4) Traffic + uptime panel on a site/app/database detail page. Upgraded from numbers-only
// to charts: requests / p50·p95 latency / error-rate / bytes-out over time (uPlot line+area), a thin
// ok/fail uptime strip, and a 1h/24h/7d range picker matching the G2 rollup granularity. uPlot is loaded
// in a LAZY chunk (React.lazy → components/Chart.tsx) so the detail bundle never ships it until a chart
// shows; the whole chart area sits behind Suspense + an ErrorBoundary, and each metric falls back to a
// plain number when its series carries no signal (an all-zero window). Numbers below stay as the totals.
import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useState } from "react";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { KV } from "../../components/Field.tsx";
import { Time } from "../../components/Time.tsx";
import { api, type Detail, type MetricsSeriesPoint } from "../../lib/api.ts";
import { POLL_DETAIL_MS } from "../../lib/query.ts";
import { RANGES, alignedData, fmtBytes, fmtCount, fmtMs, fmtPct, hasSignal, rangeMeta, uptimeCells, type Range } from "../../lib/chart-data.ts";
import type { ChartProps } from "../../components/Chart.tsx";

// uPlot + its stylesheet live in this lazily-loaded chunk only (verified separate in the build output).
const Chart = lazy(() => import("../../components/Chart.tsx"));

/** "99.8% (24h) · 45ms" — or a plain-language fallback when there's no data yet. */
function uptimeLine(u: NonNullable<Detail["uptime"]>): string {
  if (u.last24hPct == null) return "no checks yet";
  const latency = u.lastCheck ? ` · ${u.lastCheck.latencyMs}ms` : "";
  const down = u.lastCheck && !u.lastCheck.ok ? " · last check DOWN" : "";
  return `${u.last24hPct}% (24h)${latency}${down}`;
}

export function MetricsPanel({ d }: { d: Detail }) {
  const [range, setRange] = useState<Range>("1h");
  // Keyed by range so switching the picker refetches (and caches) per window.
  const q = useQuery({
    queryKey: ["/v1/sites", d.name, "metrics", range],
    queryFn: () => api.metrics(d.name, range),
    refetchInterval: POLL_DETAIL_MS,
  });
  // The uptime strip is range-independent (the last-24h probe history).
  const upq = useQuery({ queryKey: ["/v1/sites", d.name, "uptime"], queryFn: () => api.uptime(d.name) });

  const series = q.data?.series ?? [];
  const t = q.data?.totals;
  const meta = rangeMeta(range);
  const errPct = t && t.requests > 0 ? `${((t.errors / t.requests) * 100).toFixed(1)}% (${t.errors})` : "—";

  return (
    <div className="sec metrics-panel">
      <div className="sec-h">
        <h3>traffic &amp; uptime</h3>
        <div className="range-picker" role="group" aria-label="time range">
          {RANGES.map((r) => (
            <button key={r} className={`range-btn${r === range ? " active" : ""}`} aria-pressed={r === range} onClick={() => setRange(r)}>
              {rangeMeta(r).label}
            </button>
          ))}
        </div>
      </div>

      {/* uptime strip — a thin ok/fail timeline off the last-24h probe history. */}
      {upq.data?.checks && upq.data.checks.length > 0 && <UptimeStrip checks={upq.data.checks} summary={d.uptime} />}
      {d.uptime && <KV label="uptime">{uptimeLine(d.uptime)}</KV>}

      {q.isError && <div className="err">{(q.error as Error).message}</div>}

      {/* Charts (lazy) — each falls back to a number when its series has no signal. The whole grid is
          behind Suspense + a boundary so a chart-runtime failure never takes down the panel. */}
      {series.length > 0 && (
        <ErrorBoundary resetKey={`${d.name}-${range}`}>
          <Suspense fallback={<div className="chart-grid-skel" aria-hidden />}>
            <div className="chart-grid">
              <MetricChart title="requests" hint={`${meta.label} · ${fmtCount(t?.requests ?? 0)} total`} series={series} keys={["requests"]} config={[{ label: "requests", strokeVar: "--accent", fillVar: "--ok-bg" }]} fmt={fmtCount} fallback={t ? String(t.requests) : "—"} />
              <MetricChart title="latency p50 · p95" hint={t ? `${fmtMs(t.p50)} · ${fmtMs(t.p95)}` : ""} series={series} keys={["p50", "p95"]} config={[{ label: "p50", strokeVar: "--info-fg" }, { label: "p95", strokeVar: "--warn-fg" }]} fmt={fmtMs} fallback={t ? `${fmtMs(t.p50)} · ${fmtMs(t.p95)}` : "—"} signalKey="p95" />
              <MetricChart title="error rate" hint={errPct} series={series} keys={["errorRate"]} config={[{ label: "error rate", strokeVar: "--danger-fg", fillVar: "--danger-bg" }]} fmt={fmtPct} fallback={errPct} signalKey="errorRate" />
              <MetricChart title="bytes out" hint={fmtBytes(t?.bytesOut ?? 0)} series={series} keys={["bytesOut"]} config={[{ label: "bytes out", strokeVar: "--purple-fg", fillVar: "--purple-bg" }]} fmt={fmtBytes} fallback={fmtBytes(t?.bytesOut ?? 0)} signalKey="bytesOut" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Numbers stay as the always-present totals + the empty-window fallback. */}
      {q.isLoading && !q.data && <p className="muted">loading…</p>}
      {t && (
        <div className="metrics-totals">
          <KV label={`requests (${meta.label})`}>{t.requests}</KV>
          <KV label="p50 · p95">
            {fmtMs(t.p50)} · {fmtMs(t.p95)}
          </KV>
          <KV label={`errors (${meta.label})`}>{errPct}</KV>
          <KV label={`bytes out (${meta.label})`}>{fmtBytes(t.bytesOut)}</KV>
          {t.requests === 0 && <div className="sub">no traffic in the last {meta.label}</div>}
        </div>
      )}
    </div>
  );
}

/** One metric's small chart, or its number when the series carries no signal (all-zero window). */
function MetricChart({
  title,
  hint,
  series,
  keys,
  config,
  fmt,
  fallback,
  signalKey,
}: {
  title: string;
  hint: string;
  series: MetricsSeriesPoint[];
  keys: ChartKeys;
  config: ChartProps["series"];
  fmt: (v: number) => string;
  fallback: string;
  signalKey?: ChartKeys[number];
}) {
  const signal = hasSignal(series, signalKey ?? keys[0]!);
  return (
    <div className="chart-cell">
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        {hint && <span className="chart-hint">{hint}</span>}
      </div>
      {signal ? (
        <Chart data={alignedData(series, keys)} series={config} ariaLabel={`${title} over time`} fmt={fmt} />
      ) : (
        <div className="chart-empty">
          <span className="chart-empty-val">{fallback}</span>
          <span className="sub">no {title} in this window</span>
        </div>
      )}
    </div>
  );
}
type ChartKeys = Parameters<typeof alignedData>[1];

/** A thin per-check ok/fail strip (oldest → newest). Green = ok, red = failed; hover a cell for its
 *  status/latency/time. Renders a summary caption from the detail uptime block when present. */
function UptimeStrip({ checks, summary }: { checks: Parameters<typeof uptimeCells>[0]; summary?: Detail["uptime"] }) {
  const cells = uptimeCells(checks);
  return (
    <div className="uptime-strip-wrap">
      <div className="uptime-strip" role="img" aria-label={`uptime: ${cells.filter((c) => c.ok).length}/${cells.length} checks ok`}>
        {cells.map((c, i) => (
          <span key={i} className={`uptime-cell ${c.ok ? "ok" : "fail"}`} title={`${c.ok ? "ok" : "fail"} · ${c.status || "tcp"} · ${c.latencyMs}ms · ${c.at}`} />
        ))}
      </div>
      <div className="uptime-caption sub">
        {summary?.last24hPct != null ? `${summary.last24hPct}% ok (24h)` : `${cells.length} checks`}
        {summary?.lastCheck && (
          <>
            {" · last "}
            <Time at={summary.lastCheck.at} />
          </>
        )}
      </div>
    </div>
  );
}
