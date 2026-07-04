// (M4) Pure chart-data transforms — series shaping, sparkline path geometry, range bucketing, number
// formatting. uPlot itself isn't exercised (no canvas under happy-dom); these transforms are the tested
// seam the Chart wrapper turns into a plot.
import { describe, expect, test } from "bun:test";
import {
  alignedData,
  errorRate,
  fmtBytes,
  fmtCount,
  fmtMs,
  fmtPct,
  hasSignal,
  metricValues,
  rangeMeta,
  sparklineArea,
  sparklinePath,
  timestamps,
  uptimeCells,
} from "./chart-data.ts";
import type { MetricsSeriesPoint, UptimeLastCheck } from "./api.ts";

const pt = (over: Partial<MetricsSeriesPoint>): MetricsSeriesPoint => ({
  minute: "2026-07-04T00:00:00.000Z",
  requests: 0,
  p50: 0,
  p95: 0,
  errors: 0,
  bytesOut: 0,
  ...over,
});

describe("number formatting", () => {
  test("fmtBytes uses binary units", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KiB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(fmtBytes(-1)).toBe("—");
  });
  test("fmtCount compacts thousands/millions", () => {
    expect(fmtCount(42)).toBe("42");
    expect(fmtCount(1500)).toBe("1.5k");
    expect(fmtCount(2_300_000)).toBe("2.3M");
  });
  test("fmtMs switches to seconds past 1s", () => {
    expect(fmtMs(45)).toBe("45ms");
    expect(fmtMs(1500)).toBe("1.5s");
    expect(fmtMs(-1)).toBe("—");
  });
  test("fmtPct trims a trailing .0", () => {
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(12.34)).toBe("12.3%");
    expect(fmtPct(100)).toBe("100%");
  });
});

describe("series → uPlot shaping", () => {
  const series = [pt({ minute: "2026-07-04T00:00:00.000Z", requests: 10, p50: 5, p95: 9, errors: 1, bytesOut: 100 }), pt({ minute: "2026-07-04T00:01:00.000Z", requests: 20, p50: 6, p95: 12, errors: 0, bytesOut: 200 })];

  test("errorRate is a 0–100 percentage, zero on no traffic", () => {
    expect(errorRate({ requests: 10, errors: 1 })).toBeCloseTo(10);
    expect(errorRate({ requests: 0, errors: 0 })).toBe(0);
  });
  test("metricValues extracts one column, computing errorRate", () => {
    expect(metricValues(series, "requests")).toEqual([10, 20]);
    expect(metricValues(series, "errorRate")).toEqual([10, 0]);
  });
  test("timestamps are unix seconds", () => {
    expect(timestamps(series)).toEqual([Math.floor(Date.parse("2026-07-04T00:00:00.000Z") / 1000), Math.floor(Date.parse("2026-07-04T00:01:00.000Z") / 1000)]);
  });
  test("alignedData is [xs, ...ys] in the requested key order", () => {
    const d = alignedData(series, ["requests", "p95"]);
    expect(d.length).toBe(3);
    expect(d[1]).toEqual([10, 20]);
    expect(d[2]).toEqual([9, 12]);
  });
  test("hasSignal detects a non-zero sample (and its absence)", () => {
    expect(hasSignal(series, "requests")).toBe(true);
    expect(hasSignal([pt({}), pt({})], "requests")).toBe(false);
    expect(hasSignal(series, "errorRate")).toBe(true); // first point has 1/10 errors
  });
});

describe("sparkline geometry", () => {
  test("empty series → empty path", () => {
    expect(sparklinePath([])).toBe("");
    expect(sparklineArea([1])).toBe(""); // area needs ≥2 points
  });
  test("single value draws a flat mid-line", () => {
    expect(sparklinePath([5], 100, 24)).toContain("M");
  });
  test("path starts with M and has one L per subsequent point", () => {
    const d = sparklinePath([1, 2, 3], 100, 20);
    expect(d.startsWith("M")).toBe(true);
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });
  test("larger values sit HIGHER (smaller y) than smaller ones", () => {
    // two points 0 then 10 in a 100x20 box (pad 1): the max maps near the top (y≈pad), min near bottom.
    const d = sparklinePath([0, 10], 100, 20, 1);
    const coords = d.replace("M", "").split(" L").map((s) => s.split(" ").map(Number));
    expect(coords[1]![1]).toBeLessThan(coords[0]![1]); // second (value 10) is higher up
  });
  test("area path closes back to the baseline", () => {
    const a = sparklineArea([1, 2, 3], 100, 20);
    expect(a.endsWith("Z")).toBe(true);
  });
});

describe("range bucketing", () => {
  test("each range maps to its rollup granularity", () => {
    expect(rangeMeta("1h").bucketSec).toBe(60);
    expect(rangeMeta("24h").bucketSec).toBe(3600);
    expect(rangeMeta("7d").bucketSec).toBe(6 * 3600);
  });
  test("an unknown range falls back to 1h", () => {
    expect(rangeMeta("nope" as unknown as "1h").range).toBe("1h");
  });
});

describe("uptime strip cells", () => {
  const chk = (ok: boolean, at: string): UptimeLastCheck => ({ ok, latencyMs: 12, status: ok ? 200 : 500, at });
  test("reverses newest-first checks to oldest→newest and caps the count", () => {
    const checks = [chk(true, "t3"), chk(false, "t2"), chk(true, "t1")]; // newest-first
    const cells = uptimeCells(checks);
    expect(cells.map((c) => c.at)).toEqual(["t1", "t2", "t3"]);
    expect(uptimeCells(Array(100).fill(chk(true, "x")), 60).length).toBe(60);
  });
});
