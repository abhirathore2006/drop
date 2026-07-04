import { describe, expect, test } from "bun:test";
import { normalizeStatus, type NormalizeStatusInput, type NormalizedStatus } from "./status.ts";

type Case = { name: string; input: NormalizeStatusInput; want: NormalizedStatus };

const app = (over: Partial<NonNullable<NormalizeStatusInput["appStatus"]>> = {}): NormalizeStatusInput["appStatus"] => ({
  replicas: 1,
  ready: 1,
  restarts: 0,
  reason: "Running",
  ...over,
});
const db = (over: Partial<NonNullable<NormalizeStatusInput["dbStatus"]>> = {}): NormalizeStatusInput["dbStatus"] => ({
  phase: "Cluster in healthy state",
  ready: 1,
  instances: 1,
  hibernated: false,
  ...over,
});

export const STATUS_TABLE: Case[] = [
  // --- sites: always-on static content ---
  { name: "site is always running", input: { type: "site" }, want: { status: "running", reason: "serving" } },

  // --- apps ---
  {
    name: "app stopped via runtimeState wins over pod status",
    input: { type: "app", runtimeState: "stopped", appStatus: app({ reason: "Stopped" }) },
    want: { status: "stopped", reason: "stopped" },
  },
  {
    name: "app reason Stopped without runtimeState",
    input: { type: "app", appStatus: app({ reason: "Stopped", ready: 0, replicas: 0 }) },
    want: { status: "stopped", reason: "stopped" },
  },
  {
    name: "app with no status yet is progressing",
    input: { type: "app", runtimeState: "running", appStatus: null },
    want: { status: "progressing", reason: "status unavailable" },
  },
  {
    name: "app scaled to zero is asleep",
    input: { type: "app", appStatus: app({ replicas: 0, ready: 0, reason: "ScaledToZero" }) },
    want: { status: "asleep", reason: "scaled to zero" },
  },
  {
    name: "app crash-looping is error",
    input: { type: "app", appStatus: app({ ready: 0, reason: "CrashLoopBackOff" }) },
    want: { status: "error", reason: "CrashLoopBackOff" },
  },
  {
    name: "app image pull failure is error",
    input: { type: "app", appStatus: app({ ready: 0, reason: "ImagePullBackOff" }) },
    want: { status: "error", reason: "ImagePullBackOff" },
  },
  {
    name: "app pending pod is progressing",
    input: { type: "app", appStatus: app({ ready: 0, reason: "Pending" }) },
    want: { status: "progressing", reason: "Pending" },
  },
  {
    name: "app container creating is progressing",
    input: { type: "app", appStatus: app({ ready: 0, reason: "ContainerCreating" }) },
    want: { status: "progressing", reason: "ContainerCreating" },
  },
  {
    name: "app NoPods with desired replicas is progressing",
    input: { type: "app", appStatus: app({ replicas: 2, ready: 0, reason: "NoPods" }) },
    want: { status: "progressing", reason: "no pods yet" },
  },
  {
    name: "app NoPods with zero replicas is asleep",
    input: { type: "app", appStatus: app({ replicas: 0, ready: 0, reason: "NoPods" }) },
    want: { status: "asleep", reason: "scaled to zero" },
  },
  {
    name: "app fully ready is running",
    input: { type: "app", runtimeState: "running", appStatus: app({ replicas: 2, ready: 2 }) },
    want: { status: "running", reason: "2/2 ready" },
  },
  {
    name: "app partially ready is degraded",
    input: { type: "app", appStatus: app({ replicas: 3, ready: 1 }) },
    want: { status: "degraded", reason: "1/3 ready" },
  },
  {
    name: "app zero ready but pods Running is progressing",
    input: { type: "app", appStatus: app({ replicas: 2, ready: 0 }) },
    want: { status: "progressing", reason: "0/2 ready" },
  },

  // --- databases ---
  {
    name: "db with no status yet is progressing",
    input: { type: "database", dbStatus: null },
    want: { status: "progressing", reason: "status unavailable" },
  },
  {
    name: "db hibernated is asleep",
    input: { type: "database", dbStatus: db({ hibernated: true, ready: 0 }) },
    want: { status: "asleep", reason: "hibernated" },
  },
  {
    name: "db healthy is running",
    input: { type: "database", dbStatus: db() },
    want: { status: "running", reason: "Cluster in healthy state" },
  },
  {
    name: "db healthy but under-replicated is degraded",
    input: { type: "database", dbStatus: db({ instances: 3, ready: 2 }) },
    want: { status: "degraded", reason: "2/3 ready" },
  },
  {
    name: "db failed phase is error",
    input: { type: "database", dbStatus: db({ phase: "Failed to create cluster", ready: 0 }) },
    want: { status: "error", reason: "Failed to create cluster" },
  },
  {
    name: "db unable-to-proceed phase is error",
    input: { type: "database", dbStatus: db({ phase: "Cluster upgrade failed, unable to proceed", ready: 0 }) },
    want: { status: "error", reason: "Cluster upgrade failed, unable to proceed" },
  },
  {
    name: "db setting up primary is progressing",
    input: { type: "database", dbStatus: db({ phase: "Setting up primary", ready: 0 }) },
    want: { status: "progressing", reason: "Setting up primary" },
  },
  {
    name: "db empty phase is progressing",
    input: { type: "database", dbStatus: db({ phase: "", ready: 0 }) },
    want: { status: "progressing", reason: "provisioning" },
  },

  // --- auth (K1): the GoTrue engine Deployment pinned 1/1 — deployment-backed like a cache ---
  { name: "auth with no status yet is progressing", input: { type: "auth", authStatus: null }, want: { status: "progressing", reason: "status unavailable" } },
  {
    name: "auth engine ready is running",
    input: { type: "auth", authStatus: app({ replicas: 1, ready: 1 }) },
    want: { status: "running", reason: "1/1 ready" },
  },
  {
    name: "auth engine crash-looping is error",
    input: { type: "auth", authStatus: app({ ready: 0, reason: "CrashLoopBackOff" }) },
    want: { status: "error", reason: "CrashLoopBackOff" },
  },
];

describe("normalizeStatus", () => {
  for (const c of STATUS_TABLE) {
    test(c.name, () => {
      expect(normalizeStatus(c.input)).toEqual(c.want);
    });
  }
});
