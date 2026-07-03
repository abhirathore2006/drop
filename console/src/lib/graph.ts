// Pure data-transform layer for the read-only stack canvas (C1). No React, no @xyflow — so it's
// unit-testable in isolation and shared by both the (lazy) canvas chunk and the page/tests.
//   - nodeDotClass:  normalized-status enum → status-dot color bucket.
//   - layoutNodes:   hand-rolled layered left-to-right positions by topological depth (no dagre).
//   - pendingByKey:  the ?include_plan overlay → { resource key → pending action } for node badging.
import type { GraphEdge, GraphNode, GraphPlanStep } from "./api.ts";

/** Status-dot color for a graph node. DELIBERATELY distinct from status.ts pillClass: the canvas dot
 *  collapses to four buckets — green running / gray asleep|stopped / amber progressing / red
 *  error|degraded (degraded rides with error here, unlike the amber "warn" pill). */
export function nodeDotClass(kind: string): string {
  switch (kind) {
    case "running":
      return "sdot sdot-green";
    case "asleep":
    case "stopped":
      return "sdot sdot-gray";
    case "progressing":
      return "sdot sdot-amber";
    case "error":
    case "degraded":
      return "sdot sdot-red";
    default:
      return "sdot sdot-gray";
  }
}

export interface NodePos {
  x: number;
  y: number;
}

export const COL_W = 260; // horizontal gap between depth columns
export const ROW_H = 130; // vertical gap between rows within a column

/**
 * Layered left-to-right positions. A node's column is its LONGEST-PATH depth over the provider→consumer
 * edges (databases at depth 0, apps at 1, sites at 2 for the v1 edge kinds); rows stack within a column,
 * ordered by key for stability. Longest-path relaxation is bounded by node count, so a (shouldn't-happen)
 * cycle can't loop forever. Returns a position keyed by resource key.
 */
export function layoutNodes(nodes: GraphNode[], edges: GraphEdge[]): Record<string, NodePos> {
  const keys = new Set(nodes.map((n) => n.key));
  const depth: Record<string, number> = {};
  for (const n of nodes) depth[n.key] = 0;
  // Relax depth[to] = max(depth[from]+1). At most |nodes| passes converge an acyclic graph.
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of edges) {
      if (!keys.has(e.from) || !keys.has(e.to)) continue;
      if (depth[e.to]! < depth[e.from]! + 1) {
        depth[e.to] = depth[e.from]! + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Group keys by column, ordered by key for a stable layout across polls.
  const cols = new Map<number, string[]>();
  for (const n of [...nodes].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const c = depth[n.key]!;
    const list = cols.get(c);
    if (list) list.push(n.key);
    else cols.set(c, [n.key]);
  }
  const pos: Record<string, NodePos> = {};
  for (const [col, ks] of cols) for (let row = 0; row < ks.length; row++) pos[ks[row]!] = { x: col * COL_W, y: row * ROW_H };
  return pos;
}

/** The pending-changes overlay collapsed to { resource key → action } (create/update/delete). noop
 *  steps are already dropped server-side; this just indexes what's left so a node can badge itself. */
export function pendingByKey(plan?: GraphPlanStep[]): Record<string, GraphPlanStep["action"]> {
  const out: Record<string, GraphPlanStep["action"]> = {};
  for (const s of plan ?? []) if (s.action !== "noop") out[s.key] = s.action;
  return out;
}

/** Whether the overlay has any actionable pending step (drives the "pending changes" badge/drawer). */
export const hasPending = (plan?: GraphPlanStep[]): boolean => (plan ?? []).some((s) => s.action !== "noop");
