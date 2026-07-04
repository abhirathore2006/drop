// C1: the read-only stack canvas at /stack/:name. Header + a resource legend + the live graph, polled
// every 5 s (paused on hidden tabs by the query defaults). The heavy @xyflow canvas is code-split behind
// React.lazy so the rest of the console never pays for it; a resource legend renders the node names
// immediately (and keeps the page usable before the canvas chunk loads / on unsupported browsers). The
// ?include_plan overlay surfaces out-of-band drift as a "pending changes" drawer + per-node badges.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useMemo, useState } from "react";
import { Link } from "wouter";
import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { Modal } from "../components/Modal.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { TypeBadge } from "../components/badges.tsx";
import { api, orgLabel, stackNodePath, templatePreviewGraph, type GraphPlanStep, type StackGraph, type TemplateSpec } from "../lib/api.ts";
import { apiExtra, type DiffBadge, type OutdatedResult, type StackDiff, type UpgradeResult } from "../lib/api-extra.ts";
import { hasPending, nodeDotClass, pendingByKey } from "../lib/graph.ts";
import { POLL_DETAIL_MS } from "../lib/query.ts";
import { deriveStatus } from "../lib/status.ts";
import { StackEditor } from "../canvas/StackEditor.tsx";
// M4: canvas + edit-mode user docs land with the stack-page composition writeup in M4 (none this slice).

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

function StackView({ graph }: { graph: StackGraph }) {
  const pending = pendingByKey(graph.plan);
  const showPending = hasPending(graph.plan);
  // Edit mode (C2). The "Edit" toggle is shown UNCONDITIONALLY and the server is the authority: the `up`
  // route enforces a per-resource verb (site→publish, app→deploy, database/bucket/cache→db:create) plus
  // org create-rights for new resources; a lack of permission surfaces as a clean 403 toast at Apply. We
  // don't client-gate because the graph endpoint carries no per-resource `capabilities` (api.ts + the
  // server response are owned by another agent this slice), and fetching the whole sites list just to
  // pre-disable a toggle would be disproportionate and still race the server's authoritative check.
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  // (D2) "update available": compare the stack to its template's latest. A non-template-derived stack 404s
  // (retry off) → the query errors and the banner simply never shows. Polled lazily (no refetch interval).
  const outdatedQ = useQuery<OutdatedResult>({
    queryKey: ["/v1/stacks", graph.name, "outdated"],
    queryFn: () => apiExtra.stackOutdated(graph.name),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const outdated = outdatedQ.data;
  const updateAvailable = !!outdated && !outdated.upToDate && !!outdated.diff && outdated.diff.upstreamChanged;

  if (reviewing && updateAvailable) {
    return <UpgradeView name={graph.name} org={graph.org} outdated={outdated!} onExit={() => setReviewing(false)} />;
  }

  if (editing) {
    return (
      <>
        <div className="phead">
          <div className="dname">
            {graph.name} <span className="badge badge-app">STACK</span>
          </div>
          <div className="downer">
            {graph.org && <span title={`org slug: ${graph.org.slug}`}>org: {orgLabel(graph.org)}</span>}
          </div>
        </div>
        <StackEditor name={graph.name} baseGraph={graph} onExit={() => setEditing(false)} />
      </>
    );
  }

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
          <Button size="sm" className="stack-edit-btn" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
      </div>

      {/* (D2) update-available banner — opens the upstream-diff review view. */}
      {updateAvailable && (
        <div className="update-banner" data-testid="update-banner">
          <span className="update-banner-txt">
            Update available — <b>{outdated!.template}</b> v{outdated!.fromVersion} → <b>v{outdated!.latestVersion}</b>
            {outdated!.diff!.conflicts.length > 0 && <span className="pill pill-warn update-banner-conflicts">{outdated!.diff!.conflicts.length} conflict{outdated!.diff!.conflicts.length === 1 ? "" : "s"}</span>}
          </span>
          <Button size="sm" variant="primary" onClick={() => setReviewing(true)}>
            Review update
          </Button>
        </div>
      )}

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

// ---- D2: upstream-diff review view -----------------------------------------------------------------
type Resolution = "take-upstream" | "keep-local";

// Build a UNION canvas (current ∪ latest resources) so added/changed/removed nodes all appear, each with
// its diff badge. Prefers the latest resource def (so an upstream field change shows), else the local one
// (so a removed-locally / removed-upstream node still renders).
function unionGraph(latest: TemplateSpec, current: TemplateSpec, diff: StackDiff): { graph: StackGraph; badges: Record<string, DiffBadge> } {
  const keys = new Set<string>([...Object.keys(latest.resources), ...Object.keys(current.resources)]);
  const resources: TemplateSpec["resources"] = {};
  for (const k of keys) resources[k] = (latest.resources[k] ?? current.resources[k])!;
  const graph = templatePreviewGraph({ name: current.name, resources });
  const badges: Record<string, DiffBadge> = {};
  for (const r of diff.resources) if (r.badge !== "unchanged") badges[r.key] = r.badge;
  return { graph, badges };
}

const CLASS_LABEL: Record<string, string> = {
  "upstream-only": "upstream change",
  "local-only": "local drift",
  conflict: "conflict",
  "added-upstream": "added upstream",
  "removed-upstream": "removed upstream",
  "added-local": "added locally",
  "removed-local": "removed locally",
};

function UpgradeView({ name, org, outdated, onExit }: { name: string; org?: StackGraph["org"]; outdated: OutdatedResult; onExit: () => void }) {
  const qc = useQueryClient();
  const diff = outdated.diff!;
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [plan, setPlan] = useState<UpgradeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const allResolved = diff.conflicts.every((k) => resolutions[k]);
  const resolutionsArg = () => (Object.keys(resolutions).length ? resolutions : undefined);
  const { graph, badges } = useMemo(
    () => (outdated.latest && outdated.current ? unionGraph(outdated.latest, outdated.current, diff) : { graph: null as StackGraph | null, badges: {} as Record<string, DiffBadge> }),
    [outdated, diff],
  );

  const dryRun = useMutation({
    mutationFn: () => apiExtra.stackUpgrade(name, { resolutions: resolutionsArg() }, true),
    onSuccess: (p) => {
      setErr(null);
      setPlan(p);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const execute = useMutation({
    mutationFn: () => apiExtra.stackUpgrade(name, { resolutions: resolutionsArg() }, false),
    onSuccess: async () => {
      setPlan(null);
      await qc.invalidateQueries({ queryKey: ["/v1/stacks", name] });
      onExit();
    },
    onError: (e) => setErr((e as Error).message),
  });

  const changed = diff.resources.filter((r) => r.class !== "unchanged");

  return (
    <>
      <div className="phead">
        <div className="dname">
          {name} <span className="badge badge-app">STACK</span> <span className="pill pill-progress">upstream update</span>
        </div>
        <div className="downer">
          {org && <span title={`org slug: ${org.slug}`}>org: {orgLabel(org)} · </span>}
          {outdated.template} v{outdated.fromVersion} → <b>v{outdated.latestVersion}</b>
          <Button size="sm" className="stack-edit-btn" onClick={onExit}>
            ← back
          </Button>
        </div>
      </div>

      {err && <div className="err">{err}</div>}

      {/* Per-resource diff legend (always rendered — the source of truth the tests assert on). A conflicted
          key carries take-upstream / keep-local toggles that gate the Upgrade button. */}
      <div className="diff-legend" data-testid="diff-legend">
        {changed.map((r) => (
          <DiffRow key={r.key} r={r} resolution={resolutions[r.key]} onResolve={(how) => setResolutions((prev) => ({ ...prev, [r.key]: how }))} />
        ))}
        {changed.length === 0 && <p className="muted">No upstream changes.</p>}
      </div>

      <div className="diff-actions">
        <Button variant="primary" data-testid="upgrade-btn" disabled={!allResolved || dryRun.isPending} loading={dryRun.isPending} onClick={() => dryRun.mutate()}>
          {diff.conflicts.length && !allResolved ? `Resolve ${diff.conflicts.length - Object.keys(resolutions).filter((k) => diff.conflicts.includes(k)).length} conflict(s) to upgrade` : "Upgrade…"}
        </Button>
        {diff.hasLocalDrift && <span className="muted small"> Local drift is preserved unless you choose “take upstream”.</span>}
      </div>

      {/* Reused C1 canvas fed the union spec + diff badges (best-effort; the legend above is the testable
          surface). */}
      {graph && (
        <ErrorBoundary resetKey={name}>
          <div className="stack-canvas">
            <Suspense fallback={<div className="spin">loading diff…</div>}>
              <StackCanvas graph={graph} preview diffBadges={badges} />
            </Suspense>
          </div>
        </ErrorBoundary>
      )}

      <UpgradePlanModal plan={plan} busy={execute.isPending} onConfirm={() => execute.mutate()} onCancel={() => setPlan(null)} />
    </>
  );
}

function DiffRow({ r, resolution, onResolve }: { r: StackDiff["resources"][number]; resolution?: Resolution; onResolve: (how: Resolution) => void }) {
  return (
    <div className={`diff-row diff-row-${r.badge}`} data-testid={`diff-row-${r.key}`}>
      <div className="diff-row-head">
        <span className={`snode-diff snode-diff-${r.badge}`} data-testid={`diff-badge-${r.key}`}>
          {r.badge}
        </span>
        <b className="diff-key">{r.key}</b>
        <span className="muted small">{CLASS_LABEL[r.class] ?? r.class}</span>
      </div>
      {r.fields.length > 0 && (
        <ul className="diff-fields">
          {r.fields.map((f) => (
            <li key={f.field} className={`diff-field diff-field-${f.class}`}>
              <code>{f.field}</code>{" "}
              {f.class === "conflict" ? (
                <span className="muted small">
                  pinned={fmtDiffVal(f.pinned)} · latest={fmtDiffVal(f.latest)} · local={fmtDiffVal(f.current)}
                </span>
              ) : f.class === "upstream-only" ? (
                <span className="muted small">
                  {fmtDiffVal(f.pinned)} → {fmtDiffVal(f.latest)} (upstream)
                </span>
              ) : (
                <span className="muted small">
                  {fmtDiffVal(f.pinned)} → {fmtDiffVal(f.current)} (local)
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {r.conflict && (
        <div className="diff-resolve" role="radiogroup" aria-label={`resolve ${r.key}`}>
          <Button size="sm" variant={resolution === "take-upstream" ? "primary" : undefined} aria-pressed={resolution === "take-upstream"} data-testid={`take-upstream-${r.key}`} onClick={() => onResolve("take-upstream")}>
            take upstream
          </Button>
          <Button size="sm" variant={resolution === "keep-local" ? "primary" : undefined} aria-pressed={resolution === "keep-local"} data-testid={`keep-local-${r.key}`} onClick={() => onResolve("keep-local")}>
            keep local
          </Button>
        </div>
      )}
    </div>
  );
}

function UpgradePlanModal({ plan, busy, onConfirm, onCancel }: { plan: UpgradeResult | null; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  if (!plan) return null;
  const actionable = (plan.plan ?? []).filter((s) => s.action !== "noop");
  return (
    <Modal open title="Review upgrade plan" onClose={onCancel}>
      {actionable.length === 0 ? (
        <div className="modal-body">No changes to apply.</div>
      ) : (
        <table className="plan-table" data-testid="upgrade-plan-table">
          <thead>
            <tr>
              <th>action</th>
              <th>kind</th>
              <th>key</th>
              <th>reason</th>
            </tr>
          </thead>
          <tbody>
            {actionable.map((s) => (
              <tr key={`${s.action}-${s.key}`} className={`plan-row plan-${s.action}`}>
                <td>
                  <span className={`snode-tag snode-tag-${s.action}`}>{ACTION_WORD[s.action]}</span>
                </td>
                <td>{s.kind}</td>
                <td>
                  <b>{s.key}</b>
                </td>
                <td className="muted small">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="modal-actions">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          cancel
        </Button>
        <Button size="sm" variant="primary" loading={busy} disabled={actionable.length === 0} onClick={onConfirm} data-testid="confirm-upgrade">
          Confirm &amp; upgrade
        </Button>
      </div>
    </Modal>
  );
}

const fmtDiffVal = (v: unknown): string => (v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v));
