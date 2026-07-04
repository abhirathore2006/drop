// The @xyflow/react canvas — loaded ONLY via React.lazy from StackPage, so xyflow + its stylesheet land
// in a separate build chunk that the list/detail pages never download. The stylesheet is imported HERE
// (in the lazy chunk); Vite extracts it to a hashed external .css loaded via <link> — no inline <style>,
// so the strict same-origin CSP (style-src 'self') holds. xyflow applies node transforms via React inline
// style props (CSSOM writes), which CSP style-src does not gate. Read-only: no dragging, no connecting.
import "@xyflow/react/dist/style.css";
import { ReactFlow, Background, Controls, Handle, Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useMemo } from "react";
import { useLocation } from "wouter";
import { StackNodeBody } from "../components/StackNodeBody.tsx";
import { stackNodePath, type GraphNode, type GraphPlanStep, type StackGraph } from "../lib/api.ts";
import { layoutNodes, pendingByKey } from "../lib/graph.ts";

// (D2) `diffBadge` — a template-upgrade badge (added/changed/removed/conflict) overlaid on a node in the
// upstream-diff view. Kept OUT of StackNodeBody (rendered here, in the canvas wrapper) so the badge is an
// additive canvas-only concern and the shared node body is untouched.
type DiffBadge = "added" | "changed" | "removed" | "conflict" | "unchanged";
type StackNodeData = { node: GraphNode; pending?: GraphPlanStep["action"]; preview?: boolean; diffBadge?: DiffBadge };

// Custom node: the (xyflow-free) body plus the two connection Handles (left target, right source) for the
// left-to-right layered layout. Handles are non-connectable (read-only) but must exist so edges attach.
function StackNode({ data }: NodeProps) {
  const { node, pending, preview, diffBadge } = data as StackNodeData;
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <StackNodeBody node={node} pending={pending} preview={preview} />
      {diffBadge && diffBadge !== "unchanged" && <span className={`snode-diff snode-diff-${diffBadge}`}>{diffBadge}</span>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

const nodeTypes = { stack: StackNode };

// `preview` (D1): a template preview — nodes-only, no live status, and clicking a node does nothing (the
// resources don't exist yet). Otherwise identical to the C1 stack canvas.
// `diffBadges` (D2): key→badge for the upstream-diff view (added/changed/removed/conflict per node). An
// ADDITIVE optional prop — omitted, the canvas behaves exactly as before.
export default function StackCanvas({ graph, preview, diffBadges }: { graph: StackGraph; preview?: boolean; diffBadges?: Record<string, DiffBadge> }) {
  const [, navigate] = useLocation();

  const { nodes, edges } = useMemo(() => {
    const pos = layoutNodes(graph.nodes, graph.edges);
    const pending = pendingByKey(graph.plan);
    const nodes: Node[] = graph.nodes.map((n) => ({
      id: n.key,
      type: "stack",
      position: pos[n.key] ?? { x: 0, y: 0 },
      data: { node: n, pending: pending[n.key], preview, diffBadge: diffBadges?.[n.key] } satisfies StackNodeData,
      // read-only affordances
      draggable: false,
      connectable: false,
    }));
    const edges: Edge[] = graph.edges.map((e, i) => ({
      id: `e${i}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      label: e.label,
      type: "smoothstep",
      animated: e.kind === "uses",
      className: `sedge sedge-${e.kind}`,
    }));
    return { nodes, edges };
  }, [graph, preview, diffBadges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_e, n) => {
        const data = n.data as StackNodeData;
        if (data.preview) return; // preview nodes don't exist yet — nowhere to navigate
        navigate(stackNodePath(data.node));
      }}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
