// C1: the read-only stack canvas at /stack/:name. Header + a resource legend + the live graph, polled
// every 5 s (paused on hidden tabs by the query defaults). The heavy @xyflow canvas is code-split behind
// React.lazy so the rest of the console never pays for it; a resource legend renders the node names
// immediately (and keeps the page usable before the canvas chunk loads / on unsupported browsers). The
// ?include_plan overlay surfaces out-of-band drift as a "pending changes" drawer + per-node badges.
import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy } from "react";
import { Link } from "wouter";
import { EmptyState } from "../components/EmptyState.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { TypeBadge } from "../components/badges.tsx";
import { api, orgLabel, stackNodePath, type GraphPlanStep } from "../lib/api.ts";
import { hasPending, nodeDotClass, pendingByKey } from "../lib/graph.ts";
import { POLL_DETAIL_MS } from "../lib/query.ts";
import { deriveStatus } from "../lib/status.ts";

// The xyflow canvas lives in its OWN chunk (verified separate in the build output) — loaded on demand.
const StackCanvas = lazy(() => import("../canvas/StackCanvas.tsx"));

const ACTION_WORD: Record<GraphPlanStep["action"], string> = { create: "create", update: "update", delete: "delete", noop: "noop" };

export function StackPage({ name }: { name: string }) {
  const q = useQuery({
    queryKey: ["/v1/stacks", name, "graph"],
    queryFn: () => api.stackGraph(name),
    refetchInterval: POLL_DETAIL_MS,
  });

  return (
    <div className="page stackpage">
      <Link href="/" className="back">
        ← all workloads
      </Link>
      {q.isPending ? (
        <Skeleton lines={6} />
      ) : q.isError ? (
        <div className="err">{q.error.message}</div>
      ) : (
        <StackView graph={q.data} />
      )}
    </div>
  );
}

function StackView({ graph }: { graph: Awaited<ReturnType<typeof api.stackGraph>> }) {
  const pending = pendingByKey(graph.plan);
  const showPending = hasPending(graph.plan);

  return (
    <>
      <div className="phead">
        <div className="dname">
          {graph.name} <span className="badge badge-app">STACK</span>
        </div>
        <div className="downer">
          {graph.org && <span title={`org slug: ${graph.org.slug}`}>org: {orgLabel(graph.org)} · </span>}
          spec v{graph.specVersion} · {graph.nodes.length} resources
          {showPending && <span className="pill pill-warn pending-pill">pending changes</span>}
        </div>
      </div>

      {/* "best on desktop" — the canvas wants room; small viewports get a heads-up (CSS-only). */}
      <p className="desktop-only-note muted">The canvas is best viewed on a wider screen.</p>

      {showPending && (
        <details className="pending-drawer" open>
          <summary>
            pending changes <span className="count">{(graph.plan ?? []).filter((s) => s.action !== "noop").length}</span>
          </summary>
          <ul>
            {(graph.plan ?? [])
              .filter((s) => s.action !== "noop")
              .map((s) => (
                <li key={s.key}>
                  <span className={`snode-tag snode-tag-${s.action}`}>{ACTION_WORD[s.action]}</span> <b>{s.key}</b> ({s.siteName}) — {s.reason}
                </li>
              ))}
          </ul>
        </details>
      )}

      {/* Resource legend: node names as clickable status chips → the existing per-type detail pages.
          Renders without the canvas chunk, so the page is useful (and testable) immediately. */}
      <div className="stack-legend">
        {graph.nodes.map((n) => {
          const st = deriveStatus({ type: n.type, status: n.status });
          return (
            <Link key={n.key} href={stackNodePath(n)} className={`legend-chip${pending[n.key] ? ` legend-pending legend-${pending[n.key]}` : ""}`} title={st.reason}>
              <span className={nodeDotClass(st.status)} aria-label={st.status} />
              <span className="legend-name">{n.key}</span>
              <TypeBadge t={n.type} />
            </Link>
          );
        })}
      </div>

      {graph.nodes.length === 0 ? (
        <EmptyState title="This stack has no resources yet.">
          Reconcile it from the CLI: <code>drop up</code>.
        </EmptyState>
      ) : (
        <ErrorBoundary resetKey={graph.name}>
          <div className="stack-canvas">
            <Suspense fallback={<div className="spin">loading canvas…</div>}>
              <StackCanvas graph={graph} />
            </Suspense>
          </div>
        </ErrorBoundary>
      )}
    </>
  );
}
