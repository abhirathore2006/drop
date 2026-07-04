// (M4) MetricsPanel smoke: mocked metrics render the numbers + range picker, and switching the range
// refetches for the new window. uPlot renders nothing under happy-dom (no canvas) — the lazy Chart sits
// behind Suspense + an ErrorBoundary, so this asserts on the always-rendered surfaces (picker + totals +
// uptime strip), not canvas pixels. The chart's data prep + lifecycle are covered in chart-data.test.ts
// and the Chart wrapper's own guards.
import { setupDom } from "../../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { makeQueryClient } from "../../lib/query.ts";
import { MetricsPanel } from "./MetricsPanel.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const metricsFor = (range: string) => ({
  range,
  series: [
    { minute: "2026-07-04T00:00:00.000Z", requests: 10, p50: 5, p95: 9, errors: 1, bytesOut: 1000 },
    { minute: "2026-07-04T00:01:00.000Z", requests: 20, p50: 6, p95: 12, errors: 0, bytesOut: 2000 },
  ],
  totals: { requests: 30, errors: 1, bytesIn: 0, bytesOut: 3000, p50: 5, p95: 12 },
});
const UPTIME = { range: "24h", checks: [{ ok: true, latencyMs: 12, status: 200, at: "2026-07-04T00:01:00.000Z" }], summary: { last24hPct: 99.9, lastCheck: { ok: true, latencyMs: 12, status: 200, at: "2026-07-04T00:01:00.000Z" } } };

const D = { name: "my-app", type: "app", uptime: { last24hPct: 99.9, lastCheck: { ok: true, latencyMs: 12, status: 200, at: "2026-07-04T00:01:00.000Z" } } } as unknown as Detail;

let realFetch: typeof fetch;
let calls: string[];
beforeEach(() => {
  calls = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push(raw);
    const path = new URL(raw, "http://x");
    if (path.pathname.endsWith("/uptime")) return Promise.resolve(json(UPTIME));
    if (path.pathname.endsWith("/metrics")) return Promise.resolve(json(metricsFor(path.searchParams.get("range") ?? "1h")));
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const renderPanel = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MetricsPanel d={D} />
    </QueryClientProvider>,
  );

describe("MetricsPanel", () => {
  test("renders the range picker and the numeric totals from mocked metrics", async () => {
    const r = renderPanel();
    // the range picker
    expect(r.getByRole("button", { name: "1h" })).toBeTruthy();
    expect(r.getByRole("button", { name: "24h" })).toBeTruthy();
    expect(r.getByRole("button", { name: "7d" })).toBeTruthy();
    // totals render (requests total = 30) once the mocked metrics resolve
    expect(await r.findByText("30")).toBeTruthy();
    // the initial fetch was for the 1h window
    expect(calls.some((c) => c.includes("/metrics?range=1h"))).toBe(true);
  });

  test("switching the range refetches for the new window", async () => {
    const r = renderPanel();
    await r.findByText("30"); // 1h loaded
    fireEvent.click(r.getByRole("button", { name: "24h" }));
    await waitFor(() => expect(calls.some((c) => c.includes("/metrics?range=24h"))).toBe(true));
  });
});
