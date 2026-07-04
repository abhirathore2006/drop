import { test, expect } from "bun:test";
import { diffCrashLoops, isCrashLooping, isRecovered, type AppStatusSnapshot } from "./crashloop.ts";

const snap = (over: Partial<AppStatusSnapshot> = {}): AppStatusSnapshot => ({
  name: "api",
  orgId: "org_1",
  restarts: 0,
  ready: 1,
  replicas: 1,
  reason: "Running",
  ...over,
});

test("CrashLoopBackOff reason is always a crash loop; Running is recovered", () => {
  expect(isCrashLooping(undefined, snap({ reason: "CrashLoopBackOff", ready: 0 }))).toBe(true);
  expect(isRecovered(snap({ reason: "Running", ready: 1, replicas: 1 }))).toBe(true);
  expect(isRecovered(snap({ reason: "CrashLoopBackOff" }))).toBe(false);
});

test("climbing restarts while not-ready is a crash loop even without the reason string", () => {
  // prev=2, now=5 restarts, ready 0/1 → climbing + unhealthy → crash-loop
  expect(isCrashLooping(2, snap({ restarts: 5, ready: 0, replicas: 1, reason: "Error" }))).toBe(true);
  // climbing but now healthy (ready==replicas) → not a crash loop
  expect(isCrashLooping(2, snap({ restarts: 5, ready: 1, replicas: 1, reason: "Running" }))).toBe(false);
});

test("scaled-to-zero app is neither crashing nor recovered (left alone)", () => {
  const zero = snap({ replicas: 0, ready: 0, reason: "ScaledToZero" });
  expect(isCrashLooping(0, zero)).toBe(false);
  expect(isRecovered(zero)).toBe(false);
});

test("diff: a NEW crash-loop lands in emit; the restart map carries forward (bounded)", () => {
  const prev = new Map<string, number>();
  const d = diffCrashLoops(prev, [
    snap({ name: "api", reason: "CrashLoopBackOff", restarts: 3, ready: 0 }),
    snap({ name: "web", reason: "Running", restarts: 0, ready: 1, replicas: 1 }),
  ]);
  expect(d.emit.map((s) => s.name)).toEqual(["api"]);
  expect(d.resolve.map((s) => s.name)).toEqual(["web"]);
  expect(d.next.get("api")).toBe(3);
  expect(d.next.get("web")).toBe(0);
});

test("diff: recovery moves an app from emit to resolve across sweeps", () => {
  // sweep 1: api crash-looping
  let s = diffCrashLoops(new Map(), [snap({ name: "api", reason: "CrashLoopBackOff", restarts: 4, ready: 0 })]);
  expect(s.emit.map((x) => x.name)).toEqual(["api"]);
  // sweep 2: api recovered (Running, ready) → resolve, not emit
  s = diffCrashLoops(s.next, [snap({ name: "api", reason: "Running", restarts: 4, ready: 1, replicas: 1 })]);
  expect(s.emit).toEqual([]);
  expect(s.resolve.map((x) => x.name)).toEqual(["api"]);
});

test("diff: next map is rebuilt from the CURRENT sweep only — a vanished app drops out", () => {
  const prev = new Map<string, number>([["gone", 9], ["api", 1]]);
  const d = diffCrashLoops(prev, [snap({ name: "api", restarts: 2 })]);
  expect(d.next.has("gone")).toBe(false); // no ghost — bounded to apps seen this sweep
  expect(d.next.get("api")).toBe(2);
});
