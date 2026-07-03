// The visual body of a stack-canvas node — deliberately @xyflow-FREE so it renders (and tests) under
// plain happy-dom. The lazy canvas chunk wraps this in an @xyflow node (adds the connection Handles);
// the page legend renders it directly. Shows: status dot (normalized enum), resource key + type badge,
// materialized site name, status label + version chip, and — when the plan overlay flags it — a
// dashed pending outline + an action tag (create/update/delete).
import { deriveStatus } from "../lib/status.ts";
import { nodeDotClass } from "../lib/graph.ts";
import { shortVersion, type GraphNode, type GraphPlanStep } from "../lib/api.ts";
import { TypeBadge } from "./badges.tsx";

export function StackNodeBody({ node, pending }: { node: GraphNode; pending?: GraphPlanStep["action"] }) {
  const st = deriveStatus({ type: node.type, status: node.status });
  const cls = ["snode", pending ? `snode-pending snode-${pending}` : "", !node.exists ? "snode-missing" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls} data-testid={`snode-${node.key}`}>
      <div className="snode-top">
        <span className={nodeDotClass(st.status)} title={st.reason} aria-label={st.status} />
        <span className="snode-name">{node.key}</span>
        <TypeBadge t={node.type} />
      </div>
      <div className="snode-sub" title={node.siteName}>
        {node.siteName}
      </div>
      <div className="snode-foot">
        <span className="snode-status" title={st.reason}>
          {st.status}
        </span>
        <span className="ver">{node.currentVersion ? shortVersion(node.currentVersion) : "—"}</span>
      </div>
      {pending && <span className={`snode-tag snode-tag-${pending}`}>{pending}</span>}
    </div>
  );
}
