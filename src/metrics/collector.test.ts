import { test, expect } from "bun:test";
import { Collector, percentileFromBuckets, LATENCY_BUCKETS } from "./collector.ts";

test("record: counts requests, sums bytes, classifies status", () => {
  const c = new Collector();
  c.record("a", { status: 200, bytesIn: 10, bytesOut: 100, ms: 3 });
  c.record("a", { status: 204, bytesIn: 0, bytesOut: 0, ms: 3 });
  c.record("a", { status: 404, bytesIn: 5, bytesOut: 20, ms: 3 });
  c.record("a", { status: 500, bytesIn: 0, bytesOut: 0, ms: 3 });
  c.record("a", { status: 302, bytesIn: 0, bytesOut: 0, ms: 3 }); // 3xx: neither class, still a request
  const [row] = c.flush();
  expect(row!.requests).toBe(5);
  expect(row!.bytesIn).toBe(15);
  expect(row!.bytesOut).toBe(120);
  expect(row!.s2xx).toBe(2);
  expect(row!.s4xx).toBe(1);
  expect(row!.s5xx).toBe(1);
});

test("record: keeps hosts separate", () => {
  const c = new Collector();
  c.record("a", { status: 200, bytesIn: 0, bytesOut: 1, ms: 1 });
  c.record("b", { status: 200, bytesIn: 0, bytesOut: 2, ms: 1 });
  const rows = c.flush().sort((x, y) => x.siteName.localeCompare(y.siteName));
  expect(rows.map((r) => r.siteName)).toEqual(["a", "b"]);
  expect(rows[0]!.bytesOut).toBe(1);
  expect(rows[1]!.bytesOut).toBe(2);
});

test("flush resets: a second flush with no activity yields nothing", () => {
  const c = new Collector();
  c.record("a", { status: 200, bytesIn: 0, bytesOut: 1, ms: 1 });
  expect(c.flush()).toHaveLength(1);
  expect(c.size()).toBe(0);
  expect(c.flush()).toHaveLength(0);
});

test("recordStream: folds requests + bytes into the same host row, no status class, no latency", () => {
  const c = new Collector();
  c.record("a", { status: 200, bytesIn: 1, bytesOut: 2, ms: 3000 }); // one HTTP request in the >2500 bucket
  c.recordStream("a", { bytesIn: 500, bytesOut: 900, durationMs: 999999 }); // duration must NOT skew percentiles
  const [row] = c.flush();
  expect(row!.requests).toBe(2); // 1 http + 1 stream
  expect(row!.bytesIn).toBe(501);
  expect(row!.bytesOut).toBe(902);
  expect(row!.s2xx).toBe(1); // only the HTTP request classified
  // Only the HTTP request (ms 3000) is in the histogram; the stream duration was ignored → p95 is the
  // 3000ms bucket bound (5000), NOT the 999999ms stream lifetime.
  expect(row!.p95Ms).toBe(5000);
});

test("percentileFromBuckets: empty → 0", () => {
  expect(percentileFromBuckets(new Array(LATENCY_BUCKETS.length + 1).fill(0), 0.5)).toBe(0);
});

test("percentileFromBuckets: returns the crossing bucket's upper bound", () => {
  // three samples: one ≤5ms (bucket 0), one ≤500ms (bucket 6), one ≤5000ms (bucket 9).
  const hist = new Array(LATENCY_BUCKETS.length + 1).fill(0);
  hist[0] = 1;
  hist[6] = 1;
  hist[9] = 1;
  expect(percentileFromBuckets(hist, 0.5)).toBe(500); // 2nd of 3 lands in bucket 6 → bound 500
  expect(percentileFromBuckets(hist, 0.95)).toBe(5000); // 3rd of 3 → bucket 9 → bound 5000
});

test("percentileFromBuckets: all in the first bucket → the first bound", () => {
  const hist = new Array(LATENCY_BUCKETS.length + 1).fill(0);
  hist[0] = 100;
  expect(percentileFromBuckets(hist, 0.5)).toBe(5);
  expect(percentileFromBuckets(hist, 0.95)).toBe(5);
});

test("percentileFromBuckets: overflow bucket reports the ceiling (5000)", () => {
  const hist = new Array(LATENCY_BUCKETS.length + 1).fill(0);
  hist[LATENCY_BUCKETS.length] = 5; // all in the >5000ms overflow bucket
  expect(percentileFromBuckets(hist, 0.95)).toBe(5000);
});

test("record via the collector p50/p95 approximation end to end", () => {
  const c = new Collector();
  for (let i = 0; i < 95; i++) c.record("a", { status: 200, bytesIn: 0, bytesOut: 0, ms: 4 }); // bucket 0 (≤5)
  for (let i = 0; i < 5; i++) c.record("a", { status: 200, bytesIn: 0, bytesOut: 0, ms: 2000 }); // bucket 8 (≤2500)
  const [row] = c.flush();
  expect(row!.p50Ms).toBe(5); // median is in the fast bucket
  // 100 samples, p95 target = ceil(0.95*100) = 95 → still within the 95 fast samples → bound 5
  expect(row!.p95Ms).toBe(5);
});
