// Normalized workload status — the ONE place the free-text runtime signals (pod waiting
// reasons, CNPG phases, runtimeState) collapse into the console/CLI/MCP status enum.
// Pure and dependency-free by design: server.ts wires it into list/detail responses
// (done by the orchestrator, not here), and console/src/lib/status.ts mirrors this exact
// logic client-side until every deployed API sends the computed field.

export type WorkloadStatusKind = "running" | "asleep" | "progressing" | "degraded" | "stopped" | "error";

export interface NormalizedStatus {
  status: WorkloadStatusKind;
  reason: string;
}

export interface NormalizeStatusInput {
  type: "site" | "app" | "database";
  /** App on/off switch persisted in the metastore ("running" | "stopped"). */
  runtimeState?: "running" | "stopped" | null;
  /** Live app status from the Deployment + pods, or null/undefined when unavailable. */
  appStatus?: { replicas: number; ready: number; restarts: number; reason: string } | null;
  /** Live CNPG status, or null/undefined when unavailable. */
  dbStatus?: { phase: string; ready: number; instances: number; hibernated: boolean } | null;
}

// Pod-level waiting/terminated reasons that mean the workload is broken, not merely slow.
const APP_ERROR = /CrashLoopBackOff|ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError|CreateContainerError|RunContainerError|StartError|OOMKilled|Error|Failed/i;
// Transitional pod states — the workload is on its way up (or down), not broken yet.
const APP_PROGRESSING = /Pending|ContainerCreating|PodInitializing|Terminating|Init:/i;

export function normalizeStatus(input: NormalizeStatusInput): NormalizedStatus {
  if (input.type === "site") {
    // Static sites are always-on: served by the edge from the object store, no pods.
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
      // Desired replicas but no pods listed yet — starting up (0 desired reads ScaledToZero above).
      return st.replicas > 0 ? { status: "progressing", reason: "no pods yet" } : { status: "asleep", reason: "scaled to zero" };
    }
    if (st.replicas === 0) return { status: "asleep", reason: "scaled to zero" };
    if (st.ready >= st.replicas) return { status: "running", reason: `${st.ready}/${st.replicas} ready` };
    if (st.ready > 0) return { status: "degraded", reason: `${st.ready}/${st.replicas} ready` };
    return { status: "progressing", reason: `0/${st.replicas} ready` };
  }

  // database
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
  // "Setting up primary", "Creating a new replica", "Switchover in progress", … — in flight.
  return { status: "progressing", reason: phase || "provisioning" };
}
