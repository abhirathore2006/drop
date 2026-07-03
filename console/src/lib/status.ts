// Client-side view of the normalized status contract.
//
// When the API sends a computed `status` field (src/api/status.ts, wired by the
// orchestrator), we trust it verbatim. Until then — or against an older API — we fall
// back to MIRRORING normalizeStatus's logic over the raw fields the API already returns
// (runtimeState / app.status / database.status), so the UI behaves identically before
// and after the server starts sending it. console/src/lib/status.test.ts locks the two
// implementations together against a shared table.

import type { AppStatus, DatabaseStatus, ServerStatus, WorkloadType } from "./api.ts";

export type WorkloadStatusKind = "running" | "asleep" | "progressing" | "degraded" | "stopped" | "error";

export interface NormalizedStatus {
  status: WorkloadStatusKind;
  reason: string;
}

const KINDS = new Set<string>(["running", "asleep", "progressing", "degraded", "stopped", "error"]);

export interface DeriveStatusInput {
  type: WorkloadType;
  /** Server-computed status when the API provides it (takes precedence). */
  status?: ServerStatus | null;
  runtimeState?: "running" | "stopped" | null;
  appStatus?: AppStatus | null;
  dbStatus?: DatabaseStatus | null;
}

export function deriveStatus(input: DeriveStatusInput): NormalizedStatus {
  const s = input.status;
  if (s && typeof s.status === "string" && KINDS.has(s.status)) {
    return { status: s.status as WorkloadStatusKind, reason: typeof s.reason === "string" && s.reason ? s.reason : s.status };
  }
  return mirrorNormalizeStatus(input);
}

// ---- mirror of src/api/status.ts (keep in lockstep; the shared-table test enforces it) ----

const APP_ERROR = /CrashLoopBackOff|ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError|CreateContainerError|RunContainerError|StartError|OOMKilled|Error|Failed/i;
const APP_PROGRESSING = /Pending|ContainerCreating|PodInitializing|Terminating|Init:/i;

export function mirrorNormalizeStatus(input: Omit<DeriveStatusInput, "status">): NormalizedStatus {
  if (input.type === "site") {
    return { status: "running", reason: "serving" };
  }

  if (input.type === "app") {
    if (input.runtimeState === "stopped") return { status: "stopped", reason: "stopped" };
    const st = input.appStatus;
    if (!st) return { status: "progressing", reason: "status unavailable" };
    const reason = st.reason || "";
    if (/^Stopped$/i.test(reason)) return { status: "stopped", reason: "stopped" };
    if (/ScaledToZero/i.test(reason)) return { status: "asleep", reason: "scaled to zero" };
    if (APP_ERROR.test(reason)) return { status: "error", reason };
    if (APP_PROGRESSING.test(reason)) return { status: "progressing", reason };
    if (/NoPods/i.test(reason)) {
      return st.replicas > 0 ? { status: "progressing", reason: "no pods yet" } : { status: "asleep", reason: "scaled to zero" };
    }
    if (st.replicas === 0) return { status: "asleep", reason: "scaled to zero" };
    if (st.ready >= st.replicas) return { status: "running", reason: `${st.ready}/${st.replicas} ready` };
    if (st.ready > 0) return { status: "degraded", reason: `${st.ready}/${st.replicas} ready` };
    return { status: "progressing", reason: `0/${st.replicas} ready` };
  }

  const st = input.dbStatus;
  if (!st) return { status: "progressing", reason: "status unavailable" };
  if (st.hibernated) return { status: "asleep", reason: "hibernated" };
  const phase = st.phase || "";
  if (/fail|error|unable|unrecoverable/i.test(phase)) return { status: "error", reason: phase || "failed" };
  if (/healthy/i.test(phase)) {
    if (st.instances > 0 && st.ready >= st.instances) return { status: "running", reason: phase };
    if (st.ready > 0) return { status: "degraded", reason: `${st.ready}/${st.instances} ready` };
    return { status: "degraded", reason: phase };
  }
  return { status: "progressing", reason: phase || "provisioning" };
}

/** Visual bucket for pills/dots. */
export function pillClass(kind: WorkloadStatusKind): string {
  switch (kind) {
    case "running":
      return "pill pill-ok";
    case "error":
      return "pill pill-danger";
    case "degraded":
      return "pill pill-warn";
    case "progressing":
      return "pill pill-progress";
    case "asleep":
    case "stopped":
      return "pill pill-idle";
  }
}

/** Map a free-text phase (e.g. a backup phase: completed | running | failed | started)
 *  onto the same pill buckets — the old console ran its danger/idle regex over these. */
export function phaseKind(phase: string): WorkloadStatusKind {
  if (/fail|error/i.test(phase)) return "error";
  if (/completed|healthy/i.test(phase)) return "running";
  if (/hibernat|stopped/i.test(phase)) return "asleep";
  return "progressing";
}
