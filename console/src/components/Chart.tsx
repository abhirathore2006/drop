// (M4) A thin React wrapper around uPlot. This module is loaded ONLY via React.lazy (from MetricsPanel),
// so uPlot AND its stylesheet land in a SEPARATE build chunk that the list/detail bundles never download
// until a chart is actually shown. The stylesheet is imported HERE (in the lazy chunk); Vite extracts it
// to a hashed external .css served via <link> — no inline <style>, so the strict `style-src 'self'` CSP
// holds. uPlot itself injects no <style> element (verified) — it only writes inline element styles
// (CSSOM), which CSP does not gate. uPlot never renders meaningfully under happy-dom (no 2D canvas), so
// construction is guarded and falls back to text; the wrapper's data-prep + lifecycle are what tests cover.
import "uplot/dist/uPlot.min.css";
import uPlot from "uplot";
import { useEffect, useRef, useState } from "react";
import { subscribeTheme } from "../lib/theme.ts";
import type { AlignedData } from "../lib/chart-data.ts";

/** One plotted series. Colors are given as CSS custom-property NAMES (e.g. "--accent") and resolved
 *  against the live theme, so a light/dark switch recolors the chart. `fillVar` (optional) fills the
 *  area under the line (use a translucent bg token). */
export interface ChartSeries {
  label: string;
  strokeVar: string;
  fillVar?: string;
  width?: number;
}

export interface ChartProps {
  data: AlignedData;
  series: ChartSeries[];
  height?: number;
  /** Accessible description — the canvas is opaque to a screen reader, so the panel also shows numbers. */
  ariaLabel?: string;
  /** A short value formatter for the y-axis + cursor (e.g. bytes, ms). Defaults to the raw number. */
  fmt?: (v: number) => string;
}

function has2dCanvas(): boolean {
  try {
    return !!document.createElement("canvas").getContext("2d");
  } catch {
    return false;
  }
}

const cssVar = (name: string, fallback: string): string => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
};

export default function Chart({ data, series, height = 88, ariaLabel, fmt }: ChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped on a theme change so the plot is rebuilt with the new resolved colors.
  const [themeRev, setThemeRev] = useState(0);

  useEffect(() => subscribeTheme(() => setThemeRev((n) => n + 1)), []);

  // Build (and rebuild on theme change) the uPlot instance. Data-only updates go through the second
  // effect below (setData) so a poll refresh doesn't tear down + recreate the canvas.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // uPlot draws to a 2D canvas and schedules a commit on the next frame; if the environment has no 2D
    // context (happy-dom, very old browsers) that async commit throws OUTSIDE this try/catch. Detect it up
    // front and keep the numeric fallback instead of constructing a plot that will throw off-thread.
    if (!has2dCanvas()) {
      setFailed(true);
      return;
    }
    const width = Math.max(host.clientWidth || 600, 1);
    const axisColor = cssVar("--text-faint", "#6b7280");
    const gridColor = cssVar("--border", "#1c2128");
    const opts: uPlot.Options = {
      width,
      height,
      legend: { show: false },
      cursor: { show: true, x: true, y: false, points: { show: true } },
      scales: { x: { time: true } },
      axes: [
        { stroke: axisColor, grid: { stroke: gridColor, width: 1 }, ticks: { stroke: gridColor }, size: 24, space: 60 },
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor },
          size: 40,
          ...(fmt ? { values: (_u, splits) => splits.map((s) => fmt(s)) } : {}),
        },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: cssVar(s.strokeVar, "#9be15d"),
          width: s.width ?? 1.5,
          ...(s.fillVar ? { fill: cssVar(s.fillVar, "transparent") } : {}),
          points: { show: false },
        })),
      ],
    };
    try {
      plotRef.current = new uPlot(opts, data, host);
      setFailed(false);
    } catch {
      // No 2D canvas (happy-dom / very old browser): keep the numeric fallback the panel renders.
      setFailed(true);
    }

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const p = plotRef.current;
            if (p && host.clientWidth) p.setSize({ width: host.clientWidth, height });
          })
        : null;
    ro?.observe(host);

    return () => {
      ro?.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // Rebuild on structural changes only (series identity/height/theme); data flows via the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, height, themeRev, fmt]);

  // Cheap path for a poll refresh: feed new samples without recreating the plot.
  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={hostRef} className="chart" role="img" aria-label={ariaLabel} data-chart-failed={failed || undefined} />;
}
