// C2: edit-mode composition for the stack page. The @xyflow-FREE shell (toolbar, palette, field drawer,
// apply/plan modal, rebase dialog) is eager so it renders + tests under happy-dom; the heavy editable
// canvas is lazy (shares the @xyflow chunk with the read-only StackCanvas). Every gesture is a pure
// EditorOp over lib/stack-editor.ts; "Apply" is the SAME `/v1/stacks/:name/up` dry-run→plan→confirm→
// execute contract as `drop up`, optimistic-locked by spec_version (409 → rebase). Never calls a
// resource API directly. Secrets NEVER appear here (write-only invariant): the app form only points at
// the detail page.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useMemo, useState } from "react";
import { Link } from "wouter";
import { Button } from "../components/Button.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { Field } from "../components/Field.tsx";
import { Modal } from "../components/Modal.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { TypeBadge } from "../components/badges.tsx";
import { useToast } from "../components/Toast.tsx";
import { ApiError, type GraphPlanStep, type StackGraph } from "../lib/api.ts";
import { apiExtra, type StackDetail } from "../lib/api-extra.ts";
import type { DroppedOp } from "../lib/stack-editor.ts";
import {
  FIELDS_FOR,
  RESOURCE_KINDS,
  applyOps,
  canRedo,
  canUndo,
  commit,
  currentOps,
  edgeSemantic,
  fieldValidators,
  initEditor,
  isDirty,
  legalEdges,
  newResource,
  rebaseState,
  redo,
  siteNameOf,
  suggestKey,
  undo,
  validateAsName,
  type EditableField,
  type EditorOp,
  type EditorResource,
  type EditorState,
  type ResourceKind,
} from "../lib/stack-editor.ts";

const EditableStackCanvas = lazy(() => import("./EditableStackCanvas.tsx"));

const KIND_FIELD_HINT: Record<EditableField, { label: string; placeholder: string; kind?: "text" | "bool" }> = {
  image: { label: "image", placeholder: "ghcr.io/org/app:tag (or leave blank + push via CLI)" },
  storage: { label: "storage", placeholder: "1Gi" },
  memory: { label: "memory", placeholder: "256Mi" },
  persistent: { label: "persistent", placeholder: "", kind: "bool" },
  dir: { label: "build dir", placeholder: "./dist (CLI-side; informational)" },
};

export function StackEditor({ name, baseGraph, onExit }: { name: string; baseGraph: StackGraph; onExit: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const detailQ = useQuery({ queryKey: ["/v1/stacks", name, "detail"], queryFn: () => apiExtra.stackDetail(name), refetchOnWindowFocus: false });

  const [state, setState] = useState<EditorState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [asPrompt, setAsPrompt] = useState<{ from: string; to: string; as: string } | null>(null);
  const [plan, setPlan] = useState<{ steps: GraphPlanStep[]; needs: { key: string; kind: string; siteName: string }[] } | null>(null);
  const [prune, setPrune] = useState(false);
  const [dropped, setDropped] = useState<DroppedOp[] | null>(null);

  // Initialize the editor state once the spec arrives.
  const ready = state !== null && detailQ.data;
  if (detailQ.data && state === null) {
    setState(initEditor(detailQ.data.spec, detailQ.data.specVersion));
  }

  const base = state?.baseSpec;
  const ops = state ? currentOps(state) : [];
  const working = useMemo(() => (base ? applyOps(base, ops) : null), [base, ops]);
  const count = working ? Object.keys(working.resources).length : 0;

  const apply = (op: EditorOp) => {
    if (!state) return false;
    const { state: ns, error } = commit(state, op);
    if (error) {
      toast.error(error);
      return false;
    }
    setState(ns);
    return true;
  };

  // Add a resource from the palette → node + open its drawer.
  const addResource = (type: ResourceKind) => {
    if (!state || !base) return;
    const key = suggestKey(base, ops, type);
    if (apply({ op: "addResource", key, resource: newResource(type) })) setSelected(key);
  };

  // Magnetic connect: resolve consumer→provider orientation via the legal-edge table, direction-agnostic.
  const connect = (a: string, b: string) => {
    if (!working) return;
    const ta = working.resources[a]?.type;
    const tb = working.resources[b]?.type;
    if (!ta || !tb) return;
    let from = a,
      to = b,
      kind = legalEdges(ta, tb);
    if (!kind) {
      const k2 = legalEdges(tb, ta);
      if (k2) {
        from = b;
        to = a;
        kind = k2;
      }
    }
    if (!kind) {
      toast.error(`a ${ta} can't connect to a ${tb}`);
      return;
    }
    if (kind === "env_from") {
      const app = working.resources[to];
      setAsPrompt({ from, to, as: (app?.name ?? to).replace(/[^A-Za-z0-9]/g, "_").toUpperCase() + "_URL" });
      return;
    }
    // Magnetic connect: apply immediately and surface the injection semantics inline (B1/K1).
    if (apply({ op: "addEdge", from, to, kind })) {
      const sem = edgeSemantic(working.resources[from]!.type, working.resources[to]!.type);
      if (sem) toast.success(`${from} → ${to}: ${sem}`);
    }
  };

  // ---- Apply flow: dry-run → plan modal → confirm → execute (409 → rebase) ----
  const dryRun = useMutation({
    mutationFn: () => apiExtra.stackUp(name, { spec: working!, prune: false, spec_version: state!.baseVersion }, true),
    onSuccess: (r) => {
      setPrune(false);
      setPlan({ steps: r.plan ?? [], needs: r.needs ?? [] });
    },
    onError: (e) => handleUpError(e),
  });

  const execute = useMutation({
    mutationFn: () => apiExtra.stackUp(name, { spec: working!, prune, spec_version: state!.baseVersion }, false),
    onSuccess: async () => {
      setPlan(null);
      toast.success("stack updated");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/v1/stacks", name, "graph"] }),
        qc.invalidateQueries({ queryKey: ["/v1/stacks"] }),
        qc.invalidateQueries({ queryKey: ["/v1/stacks", name, "detail"] }),
      ]);
      onExit();
    },
    onError: (e) => handleUpError(e),
  });

  // A 409 means someone changed the stack under us: refetch, rebase the ops, show any dropped edits.
  async function handleUpError(e: unknown) {
    if (e instanceof ApiError && e.status === 409 && state) {
      setPlan(null);
      try {
        const fresh = await qc.fetchQuery({ queryKey: ["/v1/stacks", name, "detail"], queryFn: () => apiExtra.stackDetail(name), staleTime: 0 });
        const { state: ns, dropped: d } = rebaseState(state, (fresh as StackDetail).spec, (fresh as StackDetail).specVersion);
        setState(ns);
        setDropped(d); // always open the dialog so the user knows a rebase happened
      } catch {
        toast.error("the stack changed and could not be re-fetched — reopen the editor");
      }
      return;
    }
    toast.error(e instanceof Error ? e.message : "apply failed");
  }

  if (!ready || !base || !working || !state) return <Skeleton lines={6} />;

  const atCap = count >= 16;
  const selRes = selected ? working.resources[selected] : undefined;

  return (
    <div className="stack-editor">
      {/* Toolbar */}
      <div className="editor-toolbar">
        <div className="editor-tools-left">
          <span className="editor-mode-pill">editing</span>
          <span className="muted">
            {count}/16 resources · base v{state.baseVersion}
            {isDirty(state) && <b className="editor-dirty"> · {ops.length} unsaved {ops.length === 1 ? "change" : "changes"}</b>}
          </span>
        </div>
        <div className="editor-tools-right">
          <Button size="sm" onClick={() => setState(undo(state))} disabled={!canUndo(state)} title="undo">
            ↶ undo
          </Button>
          <Button size="sm" onClick={() => setState(redo(state))} disabled={!canRedo(state)} title="redo">
            ↷ redo
          </Button>
          <Button size="sm" onClick={onExit}>
            cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => dryRun.mutate()} loading={dryRun.isPending} disabled={!isDirty(state)}>
            Apply
          </Button>
        </div>
      </div>

      {/* Palette */}
      <div className="editor-palette" role="toolbar" aria-label="add resource">
        <span className="palette-label">add:</span>
        {RESOURCE_KINDS.map((k) => (
          <Button key={k} size="sm" onClick={() => addResource(k)} disabled={atCap} title={atCap ? "16-resource limit reached" : `add a ${k}`} data-testid={`palette-${k}`}>
            + {k}
          </Button>
        ))}
      </div>

      <div className="editor-body">
        <ErrorBoundary resetKey={`${name}:${ops.length}`}>
          <div className="stack-canvas editor-canvas">
            <Suspense fallback={<div className="spin">loading canvas…</div>}>
              <EditableStackCanvas base={base} ops={ops} baseGraph={baseGraph} selectedKey={selected} onConnectNodes={connect} onSelectNode={setSelected} />
            </Suspense>
          </div>
        </ErrorBoundary>

        {/* Field drawer for the selected node */}
        {selected && selRes && (
          <NodeDrawer
            stackName={base.name}
            nodeKey={selected}
            res={selRes}
            onField={(field, value) => apply({ op: "setField", key: selected, field, value })}
            onDelete={() => {
              if (apply({ op: "removeResource", key: selected })) setSelected(null);
            }}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      {/* env_from AS-name prompt */}
      <AsPrompt
        prompt={asPrompt}
        onCancel={() => setAsPrompt(null)}
        onSubmit={(as) => {
          if (asPrompt && apply({ op: "addEdge", from: asPrompt.from, to: asPrompt.to, kind: "env_from", as })) setAsPrompt(null);
        }}
      />

      {/* Plan modal (dry-run result) */}
      <PlanModal
        plan={plan}
        prune={prune}
        setPrune={setPrune}
        busy={execute.isPending}
        onConfirm={() => execute.mutate()}
        onCancel={() => setPlan(null)}
      />

      {/* Rebase dialog after a 409 */}
      <RebaseDialog
        dropped={dropped}
        onReapply={() => {
          setDropped(null);
          dryRun.mutate();
        }}
        onDiscard={() => {
          setDropped(null);
        }}
      />
    </div>
  );
}

// ---- field drawer ------------------------------------------------------------------------------------
function NodeDrawer({
  stackName,
  nodeKey,
  res,
  onField,
  onDelete,
  onClose,
}: {
  stackName: string;
  nodeKey: string;
  res: EditorResource;
  onField: (field: EditableField, value: unknown) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const siteName = siteNameOf({ name: stackName, resources: {} }, nodeKey, res);
  return (
    <aside className="node-drawer" aria-label={`edit ${nodeKey}`}>
      <div className="drawer-head">
        <div>
          <div className="drawer-title">{nodeKey}</div>
          <div className="drawer-sub">
            <TypeBadge t={res.type} /> <span className="muted">{siteName}</span>
          </div>
        </div>
        <button className="drawer-close" aria-label="close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="drawer-fields">
        {FIELDS_FOR[res.type].length === 0 && <p className="muted small">No editable fields — this resource is fully provisioned server-side.</p>}
        {FIELDS_FOR[res.type].map((field) => (
          <DrawerField key={field} field={field} value={(res as Record<string, unknown>)[field]} onChange={(v) => onField(field, v)} />
        ))}

        {res.type === "app" && (
          <p className="drawer-note muted small">
            Secrets are write-only and never shown here — manage them on the{" "}
            <Link href={`/app/${encodeURIComponent(siteName)}`}>app’s detail page</Link>.
          </p>
        )}

        {res.type === "auth" && (
          <p className="drawer-note muted small">
            {res.db ? (
              <>Users live in database <b>{res.db}</b>. </>
            ) : (
              <b className="drawer-warn">Connect this to a database (drag a line to one) — an auth resource requires it. </b>
            )}
            Providers &amp; redirect URLs (some carry secrets) are configured on the detail page — never here.
          </p>
        )}
      </div>

      <div className="drawer-actions">
        <Button size="sm" variant="danger" onClick={onDelete} title="mark for deletion (flagged in the plan)">
          delete
        </Button>
      </div>
    </aside>
  );
}

function DrawerField({ field, value, onChange }: { field: EditableField; value: unknown; onChange: (v: unknown) => void }) {
  const hint = KIND_FIELD_HINT[field];
  const [v, setV] = useState<string>(field === "persistent" ? "" : (value as string) ?? "");
  const err = field === "persistent" ? null : fieldValidators[field](v);
  if (hint.kind === "bool") {
    return (
      <label className="drawer-bool">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {hint.label}
      </label>
    );
  }
  return (
    <Field error={err}>
      <label className="drawer-field-label">{hint.label}</label>
      <input
        value={v}
        placeholder={hint.placeholder}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (!fieldValidators[field](v)) onChange(v.trim());
        }}
      />
    </Field>
  );
}

// ---- env_from AS-name prompt -------------------------------------------------------------------------
function AsPrompt({ prompt, onCancel, onSubmit }: { prompt: { from: string; to: string; as: string } | null; onCancel: () => void; onSubmit: (as: string) => void }) {
  const [as, setAs] = useState("");
  const value = as || prompt?.as || "";
  const err = value ? validateAsName(value) : null;
  if (!prompt) return null;
  return (
    <Modal open title="Name the injected variable" onClose={onCancel}>
      <div className="modal-body">
        Site <b>{prompt.from}</b> will read <b>{prompt.to}</b>’s URL at publish time. {edgeSemantic("site", "app", value)}.
      </div>
      <Field error={err}>
        <input className="confirm-name" autoFocus value={value} onChange={(e) => setAs(e.target.value)} placeholder="API_URL" />
      </Field>
      <div className="modal-actions">
        <Button size="sm" onClick={onCancel}>
          cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!value || !!err} onClick={() => onSubmit(value)}>
          connect
        </Button>
      </div>
    </Modal>
  );
}

// ---- plan modal --------------------------------------------------------------------------------------
const ACTION_WORD: Record<GraphPlanStep["action"], string> = { create: "create", update: "update", delete: "delete", noop: "noop" };

function PlanModal({
  plan,
  prune,
  setPrune,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: { steps: GraphPlanStep[]; needs: { key: string; kind: string; siteName: string }[] } | null;
  prune: boolean;
  setPrune: (v: boolean) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!plan) return null;
  const actionable = plan.steps.filter((s) => s.action !== "noop");
  const hasDeletes = actionable.some((s) => s.action === "delete");
  return (
    <Modal open title="Review plan" onClose={onCancel}>
      {actionable.length === 0 ? (
        <div className="modal-body">No changes to apply.</div>
      ) : (
        <table className="plan-table" data-testid="plan-table">
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

      {plan.needs.length > 0 && (
        <p className="plan-needs muted small">
          Needs a CLI image push: {plan.needs.map((n) => n.key).join(", ")} — the editor never builds images.
        </p>
      )}

      {hasDeletes && (
        <label className="plan-prune">
          <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} /> permanently remove flagged deletes (prune)
          <span className="muted small"> — unchecked, deletes are only flagged.</span>
        </label>
      )}

      <div className="modal-actions">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          cancel
        </Button>
        <Button size="sm" variant={hasDeletes && prune ? "danger" : "primary"} loading={busy} disabled={actionable.length === 0} onClick={onConfirm}>
          Confirm &amp; apply
        </Button>
      </div>
    </Modal>
  );
}

// ---- rebase dialog (after a 409) ---------------------------------------------------------------------
function RebaseDialog({ dropped, onReapply, onDiscard }: { dropped: DroppedOp[] | null; onReapply: () => void; onDiscard: () => void }) {
  if (!dropped) return null;
  return (
    <Modal open title="The stack changed while you were editing" onClose={onDiscard}>
      <div className="modal-body">
        Your edits were rebased onto the latest spec.
        {dropped.length === 0 ? " All of them still apply." : ` ${dropped.length} could not be replayed and were dropped:`}
      </div>
      {dropped.length > 0 && (
        <ul className="rebase-dropped">
          {dropped.map((d, i) => (
            <li key={i} className="small">
              <code>{d.op.op}</code> {"key" in d.op ? d.op.key : "from" in d.op ? `${d.op.from}→${d.op.to}` : ""} — <span className="muted">{d.reason}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <Button size="sm" onClick={onDiscard}>
          keep editing
        </Button>
        <Button size="sm" variant="primary" onClick={onReapply}>
          re-apply
        </Button>
      </div>
    </Modal>
  );
}
