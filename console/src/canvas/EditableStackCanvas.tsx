// C2: the EDITABLE @xyflow canvas. Loaded ONLY via React.lazy from StackPage (edit mode), so it lands in
// the SAME code-split chunk as the read-only StackCanvas (both dynamic-import @xyflow — Vite dedups the
// library into one shared chunk) and the list/detail pages never download it. Purely a graphical skin:
// it renders the working spec (base + ops) and turns gestures into callbacks — ALL op logic + validation
// lives in the parent (StackPage) over the pure lib/stack-editor.ts model. Never calls a resource API.
import "@xyflow/react/dist/style.css";
import { Background, Controls, Handle, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useMemo } from "react";
import { StackNodeBody } from "../components/StackNodeBody.tsx";
import type { GraphEdge, GraphNode, GraphPlanStep, StackGraph } from "../lib/api.ts";
import { layoutNodes } from "../lib/graph.ts";
import { applyOps, buildEditorGraph, legalEdges, type EditorOp, type EditorSpec } from "../lib/stack-editor.ts";

type EditNodeData = { node: GraphNode; pending?: GraphPlanStep["action"]; selected?: boolean };

// Editable node: the @xyflow-free body plus two CONNECTABLE handles (left target, right source) for the
// magnetic drag. A drag from any handle to any other fires onConnect; the parent resolves consumer/
// provider by type via the legal-edge table (direction-agnostic — the "magnet" snaps the right way).
function EditNode({ data }: NodeProps) {
  const { node, pending, selected } = data as EditNodeData;
  return (
    <div className={selected ? "enode-selected" : undefined}>
      <Handle type="target" position={Position.Left} />
      <StackNodeBody node={node} pending={pending} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { edit: EditNode };

export interface EditableStackCanvasProps {
  base: EditorSpec;
  ops: EditorOp[];
  baseGraph: StackGraph; // live status for the nodes that already exist
  selectedKey: string | null;
  onConnectNodes: (a: string, b: string) => void;
  onSelectNode: (key: string) => void;
}

export default function EditableStackCanvas({ base, ops, baseGraph, selectedKey, onConnectNodes, onSelectNode }: EditableStackCanvasProps) {
  const { nodes, edges } = useMemo(() => {
    const { nodes: enodes, edges: eedges } = buildEditorGraph(base, ops);
    const sent = applyOps(base, ops);
    const baseByKey = new Map(baseGraph.nodes.map((n) => [n.key, n]));
    // layoutNodes only reads key + from/to (topological depth); the wider EditorGraphEdge kind ("db") is
    // irrelevant to layout, so a minimal shape cast keeps the shared C1 layout helper reusable as-is.
    const pos = layoutNodes(enodes.map((n) => ({ key: n.key }) as GraphNode), eedges.map((e) => ({ from: e.from, to: e.to })) as unknown as GraphEdge[]);

    const nodes: Node[] = enodes.map((n) => {
      const live = baseByKey.get(n.key);
      // Synthesize a GraphNode for a new node (no live row yet); reuse the live one otherwise.
      const gnode: GraphNode = live ?? {
        key: n.key,
        siteName: n.siteName,
        type: n.type,
        url: "",
        currentVersion: null,
        exists: false,
        status: { status: "unknown", reason: "not applied yet" },
      };
      // pending badge: delete (soft) > create (new) > update (existing node whose config changed).
      const changed = !n.isNew && !n.pendingDelete && JSON.stringify(sent.resources[n.key]) !== JSON.stringify(base.resources[n.key]);
      const pending: GraphPlanStep["action"] | undefined = n.pendingDelete ? "delete" : n.isNew ? "create" : changed ? "update" : undefined;
      return {
        id: n.key,
        type: "edit",
        position: pos[n.key] ?? { x: 0, y: 0 },
        data: { node: { ...gnode, key: n.key, type: n.type, siteName: n.siteName }, pending, selected: n.key === selectedKey } satisfies EditNodeData,
        draggable: true,
        connectable: !n.pendingDelete,
      };
    });

    const edges: Edge[] = eedges.map((e, i) => ({
      id: `e${i}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      label: e.label,
      type: "smoothstep",
      animated: e.kind === "uses",
      className: `sedge sedge-${e.kind}`,
    }));
    return { nodes, edges };
  }, [base, ops, baseGraph, selectedKey]);

  // A connection is offer-able if EITHER orientation is a legal edge (the magnet snaps the right way).
  const typeOf = (id: string) => applyOps(base, ops).resources[id]?.type;
  const isValid = (c: Connection | Edge): boolean => {
    const a = typeOf(c.source as string);
    const b = typeOf(c.target as string);
    if (!a || !b) return false;
    return !!(legalEdges(a, b) || legalEdges(b, a));
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      nodesDraggable
      nodesConnectable
      elementsSelectable
      proOptions={{ hideAttribution: true }}
      isValidConnection={isValid}
      onConnect={(c) => c.source && c.target && onConnectNodes(c.source, c.target)}
      onNodeClick={(_e, n) => onSelectNode(n.id)}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
