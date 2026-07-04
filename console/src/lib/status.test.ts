// Locks the client-side status fallback to the server's normalizeStatus (src/api/status.ts):
// the mirror must produce IDENTICAL output for a sweep of inputs, and a server-provided
// status must win over the fallback. No DOM needed.
import { describe, expect, test } from "bun:test";
import { normalizeStatus, type NormalizeStatusInput } from "../../../src/api/status.ts";
import { deriveStatus, mirrorNormalizeStatus } from "./status.ts";

const appReasons = [
  "Running",
  "Stopped",
  "ScaledToZero",
  "NoPods",
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "OOMKilled",
  "Pending",
  "ContainerCreating",
  "PodInitializing",
  "Terminating",
  "Init:0/1",
  "Completed",
  "",
];
const dbPhases = [
  "Cluster in healthy state",
  "Setting up primary",
  "Creating a new replica",
  "Switchover in progress",
  "Failed to create cluster",
  "Cluster upgrade failed, unable to proceed",
  "",
];

function sweep(): NormalizeStatusInput[] {
  const inputs: NormalizeStatusInput[] = [{ type: "site" }, { type: "bucket" }];
  for (const runtimeState of ["running", "stopped", undefined] as const) {
    inputs.push({ type: "app", runtimeState, appStatus: null });
    for (const reason of appReasons) {
      for (const [replicas, ready] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [3, 1],
        [3, 3],
      ] as const) {
        inputs.push({ type: "app", runtimeState, appStatus: { replicas, ready, restarts: 0, reason } });
      }
    }
  }
  // (I2) caches — always-on single-replica Deployments (no runtimeState/scale-to-zero).
  inputs.push({ type: "cache", cacheStatus: null });
  for (const reason of appReasons) {
    for (const [replicas, ready] of [
      [0, 0],
      [1, 0],
      [1, 1],
    ] as const) {
      inputs.push({ type: "cache", cacheStatus: { replicas, ready, restarts: 0, reason } });
    }
  }
  inputs.push({ type: "database", dbStatus: null });
  for (const hibernated of [true, false]) {
    for (const phase of dbPhases) {
      for (const [instances, ready] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [3, 2],
        [3, 3],
      ] as const) {
        inputs.push({ type: "database", dbStatus: { phase, ready, instances, hibernated } });
      }
    }
  }
  return inputs;
}

describe("console status fallback mirrors src/api/status.ts", () => {
  test(`identical output across a ${sweep().length}-case sweep`, () => {
    for (const input of sweep()) {
      expect({ input, out: mirrorNormalizeStatus(input) }).toEqual({ input, out: normalizeStatus(input) });
    }
  });
});

describe("deriveStatus (server contract consumption)", () => {
  test("a server-provided normalized status wins over the raw fields", () => {
    const out = deriveStatus({
      type: "app",
      status: { status: "degraded", reason: "1/3 ready" },
      runtimeState: "running",
      appStatus: { replicas: 3, ready: 3, restarts: 0, reason: "Running" }, // says running — must be ignored
    });
    expect(out).toEqual({ status: "degraded", reason: "1/3 ready" });
  });

  test("a server status with an empty reason falls back to the enum as the label", () => {
    expect(deriveStatus({ type: "site", status: { status: "running", reason: "" } })).toEqual({
      status: "running",
      reason: "running",
    });
  });

  test("an unknown server status string falls back to the client mirror", () => {
    const out = deriveStatus({
      type: "app",
      status: { status: "everything-is-fine", reason: "?" },
      appStatus: { replicas: 1, ready: 0, restarts: 2, reason: "CrashLoopBackOff" },
    });
    expect(out).toEqual({ status: "error", reason: "CrashLoopBackOff" });
  });

  test("no server status at all uses the mirror", () => {
    expect(deriveStatus({ type: "database", dbStatus: { phase: "x", ready: 1, instances: 1, hibernated: true } })).toEqual({
      status: "asleep",
      reason: "hibernated",
    });
  });
});
