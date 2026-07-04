// C2: the PURE state layer behind the editable stack canvas ("magnetic connections"). No React, no
// @xyflow, no fetch — so it is unit-testable in isolation and is the bulk of the slice's test asset.
//
// THE PRINCIPLE (Plan-v5 C2): the editor is a *spec editor with a graphical skin*. It never calls
// resource APIs. Every gesture is a small, replayable command (EditorOp) over a client-side copy of the
// stack spec; `applyOps(base, ops)` folds them into the spec that `Apply` POSTs to the SAME
// `/v1/stacks/:name/up` endpoint (dry-run → plan → confirm → execute) with `spec_version` optimistic
// locking. One source of truth; CLI and canvas can never diverge.
//
// WHY MIRRORS, NOT IMPORTS: the server's `src/stack-config.ts` (validateStackEdges / sanitizeStackConfig,
// the ground truth) transitively imports `src/names.ts`, whose `generateName()` pulls in `node:crypto` —
// which Rollup cannot resolve for the browser bundle (see console/src/lib/validateName.ts's header for
// the full rationale). So the browser-safe validators here are MIRRORS, each locked to the real server
// module by a node-side lockstep test (stack-editor.legal-edges.test.ts imports the REAL
// validateStackEdges + sanitizeStackConfig and derives the legal-edge table from them — so a new edge
// kind landing server-side breaks the test rather than silently drifting).

// ---- browser-safe spec shape (structurally matches src/stack-config.ts StackSpec/StackResource) -------
// The editor reads/writes only a handful of fields; every other field rides through applyOps untouched
// (structuredClone preserves them), so an unknown field the server adds later survives a round-trip.
export type ResourceKind = "site" | "app" | "database" | "bucket" | "cache" | "auth";
// The DRAG edge kinds. `uses` (app→provider) + `env_from` (site→app) are array bindings; `db` is the
// REQUIRED scalar binding of a K1 auth resource to its Postgres (auth→database). All three are typed,
// magnetic connections — never free-form lines.
export type EdgeKind = "uses" | "env_from" | "db";

export interface EditorUse {
  database?: string;
  bucket?: string;
  cache?: string;
  auth?: string; // (K1) app→auth binding — injects AUTH_URL + AUTH_JWT_SECRET
  app?: string; // (H3) app→app binding (service discovery) — injects <KEY>_URL
  via?: string;
}
export interface EditorEnvFrom {
  resource: string;
  output: "url";
  as: string;
}
export interface EditorResource {
  type: ResourceKind;
  name?: string;
  image?: string;
  storage?: string;
  memory?: string;
  persistent?: boolean;
  dir?: string;
  env?: Record<string, string>;
  uses?: EditorUse[];
  env_from?: EditorEnvFrom[];
  db?: string; // (K1) auth→database: the database resource KEY this auth engine's users live in (REQUIRED on an auth)
  // Passthrough: any other field the server understands (trusted, services, healthcheck, auth
  // providers/redirects, …) rides through applyOps untouched (structuredClone preserves it) — the editor
  // only mutates the fields above. Auth provider config carries secrets, so it is NEVER edited here.
  [k: string]: unknown;
}
export interface EditorSpec {
  name: string;
  resources: Record<string, EditorResource>;
}

// ---- mirrored constants (src/stack-config.ts) ----------------------------------------------------------
export const MAX_RESOURCES = 16; // v1 cap — mirrors stack-config MAX_RESOURCES
const KEY_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/; // a resource key: short DNS label (1–32)
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/; // an env-var / ${as} placeholder name
const STORAGE_RE = /^\d+(\.\d+)?(Mi|Gi|Ti)$/; // db PVC quantity (mirrors db-config STORAGE_RE)
const MEMORY_RE = /^\d+(\.\d+)?(Mi|Gi)$/; // cache memory quantity (mirrors cache-config MEMORY_RE)

export const RESOURCE_KINDS: ResourceKind[] = ["site", "app", "database", "cache", "bucket", "auth"];

// ---- the legal-edge table (DERIVED from validateStackEdges semantics; lockstep-tested) -----------------
// Direction is the DRAG direction: the user drags FROM the consumer's node TO the provider's node.
//   (app  → database) uses      — app consumes a managed database
//   (app  → cache)    uses      — app consumes a Valkey cache
//   (app  → bucket)   uses      — app consumes an object bucket
//   (app  → auth)     uses      — app consumes an auth engine (K1)
//   (app  → app)      uses      — app calls a peer app; injects <KEY>_URL (H3, service discovery)
//   (site → app)      env_from  — site substitutes the app's URL at publish time
//   (auth → database) db        — auth engine's users live in that Postgres (K1; REQUIRED, scalar)
// Everything else (db→db, app→site, site→site, cycles, self) is refused. This is the SINGLE table the
// canvas consults; it is never a hardcoded stale list — the lockstep test rebuilds it from the server
// modules (validateStackEdges + sanitizeStackConfig) and fails if this drifts (as it did when K1 added
// `auth` mid-slice — that failure is what drove these two extra rows in).
export function legalEdges(fromType: ResourceKind, toType: ResourceKind): EdgeKind | null {
  if (fromType === "app" && (toType === "database" || toType === "cache" || toType === "bucket" || toType === "auth" || toType === "app")) return "uses";
  if (fromType === "site" && toType === "app") return "env_from";
  if (fromType === "auth" && toType === "database") return "db";
  return null;
}

/** The `uses` slot name for a provider kind (how the server keys an app→provider binding). (H3) a peer
 *  app is keyed by the `app` slot — same shape as the others. */
function usesSlot(providerType: ResourceKind): "database" | "bucket" | "cache" | "auth" | "app" | null {
  return providerType === "database" || providerType === "bucket" || providerType === "cache" || providerType === "auth" || providerType === "app" ? providerType : null;
}
/** The resource KEY a single `uses` entry targets (database, bucket, cache, auth, or (H3) app slot). */
const useTarget = (u: EditorUse): string | undefined => u.database ?? u.bucket ?? u.cache ?? u.auth ?? u.app;
const usesTargets = (u: EditorUse, key: string): boolean => useTarget(u) === key;

/** The inline semantic label shown while a magnetic edge snaps (B1/K1 injection semantics). */
export function edgeSemantic(fromType: ResourceKind, toType: ResourceKind, as?: string): string {
  if (fromType === "app") {
    if (toType === "database") return "injects PG* + CA";
    if (toType === "cache") return "injects REDIS_URL";
    if (toType === "bucket") return "injects S3_*";
    if (toType === "auth") return "injects AUTH_URL + AUTH_JWT_SECRET";
    if (toType === "app") return "injects <KEY>_URL"; // (H3) service discovery — the peer's key uppercased
  }
  if (fromType === "site" && toType === "app") return `injects ${as ? as : "${AS}"}`;
  if (fromType === "auth" && toType === "database") return "auth engine + users live here";
  return "";
}

// ---- the op model --------------------------------------------------------------------------------------
// Small, replayable commands. `removeResource` is a SOFT pending-delete: applyOps drops the key (so the
// server plan emits a delete step), while buildEditorGraph keeps it visible + flagged. `setField` carries
// `prev` (the value at edit time) so rebase can detect a base-side change to the same field.
export type EditorOp =
  | { op: "addResource"; key: string; resource: EditorResource }
  | { op: "removeResource"; key: string }
  | { op: "setField"; key: string; field: EditableField; value: unknown; prev?: unknown }
  | { op: "addEdge"; from: string; to: string; kind: EdgeKind; as?: string }
  | { op: "removeEdge"; from: string; to: string; kind: EdgeKind };

export type EditableField = "image" | "storage" | "memory" | "persistent" | "dir";

const clone = <T>(v: T): T => (typeof structuredClone === "function" ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T));

/** The materialized site name for a resource (mirrors resolveResourceName): explicit name, else <stack>-<key>. */
export function siteNameOf(spec: EditorSpec, key: string, res: EditorResource): string {
  return res.name ?? `${spec.name}-${key}`;
}

/** Default resource body for a freshly-added node of `type` (minimal; forms fill the rest). */
export function newResource(type: ResourceKind): EditorResource {
  switch (type) {
    case "database":
      return { type, storage: "1Gi" };
    case "cache":
      return { type, memory: "256Mi", persistent: false };
    default:
      return { type };
  }
}

/** A unique, KEY_RE-valid key for a new `type` node (`app`, `app2`, …) not colliding with existing keys. */
export function suggestKey(spec: EditorSpec, ops: EditorOp[], type: ResourceKind): string {
  const taken = new Set(Object.keys(applyOps(spec, ops).resources));
  for (const k of Object.keys(spec.resources)) taken.add(k);
  if (!taken.has(type)) return type;
  for (let i = 2; i < 100; i++) if (!taken.has(`${type}${i}`)) return `${type}${i}`;
  return `${type}${Date.now() % 1000}`;
}

// ---- applyOps: fold the command list into the spec that Apply POSTs ------------------------------------
/**
 * Produce the concrete spec to send to `/up`. A deep clone of `base` is mutated so `base` is never
 * touched (purity). `removeResource` keys are dropped; a final pass prunes any `uses`/`env_from` entry
 * whose target key no longer exists, so the emitted spec always passes validateStackEdges.
 */
export function applyOps(base: EditorSpec, ops: EditorOp[]): EditorSpec {
  const spec: EditorSpec = { name: base.name, resources: clone(base.resources) };
  for (const op of ops) {
    switch (op.op) {
      case "addResource":
        spec.resources[op.key] = clone(op.resource);
        break;
      case "removeResource":
        delete spec.resources[op.key];
        break;
      case "setField": {
        const r = spec.resources[op.key];
        if (!r) break;
        if (op.value === undefined || op.value === "" || op.value === null) delete (r as Record<string, unknown>)[op.field];
        else (r as Record<string, unknown>)[op.field] = op.value;
        break;
      }
      case "addEdge": {
        const from = spec.resources[op.from];
        if (!from) break;
        if (op.kind === "uses") {
          const slot = usesSlot(spec.resources[op.to]?.type ?? "app");
          if (!slot) break;
          from.uses = [...(from.uses ?? []).filter((u) => !usesTargets(u, op.to)), { [slot]: op.to } as EditorUse];
        } else if (op.kind === "db") {
          from.db = op.to; // scalar: replaces any existing db binding
        } else {
          from.env_from = [...(from.env_from ?? []).filter((e) => e.resource !== op.to), { resource: op.to, output: "url", as: op.as ?? op.to.toUpperCase() }];
        }
        break;
      }
      case "removeEdge": {
        const from = spec.resources[op.from];
        if (!from) break;
        if (op.kind === "uses") from.uses = (from.uses ?? []).filter((u) => !usesTargets(u, op.to));
        else if (op.kind === "db") delete from.db;
        else from.env_from = (from.env_from ?? []).filter((e) => e.resource !== op.to);
        break;
      }
    }
  }
  // Prune dangling edges (target deleted underneath a `uses`/`env_from`/`db`) so the POSTed spec is
  // edge-sound. Note: pruning an auth's `db` leaves it invalid (auth REQUIRES a db) — the server 400 then
  // guides the user to reconnect it; that's the correct signal, not something to paper over here.
  for (const r of Object.values(spec.resources)) {
    if (r.uses) {
      r.uses = r.uses.filter((u) => {
        const t = useTarget(u);
        return !t || t in spec.resources;
      });
      if (!r.uses.length) delete r.uses;
    }
    if (r.env_from) {
      r.env_from = r.env_from.filter((e) => e.resource in spec.resources);
      if (!r.env_from.length) delete r.env_from;
    }
    if (r.db && !(r.db in spec.resources)) delete r.db;
  }
  return spec;
}

/** Keys marked for (soft) deletion that still exist in `base` — the nodes the canvas renders dashed-red. */
export function pendingDeleteKeys(base: EditorSpec, ops: EditorOp[]): string[] {
  const del = new Set<string>();
  for (const op of ops) {
    if (op.op === "removeResource" && op.key in base.resources) del.add(op.key);
    if (op.op === "addResource") del.delete(op.key); // re-added after delete → not pending-delete
  }
  return [...del];
}

// ---- edge derivation (mirrors src/api/server.ts graph edge derivation) ---------------------------------
export interface EditorGraphEdge {
  from: string; // provider KEY (visual left)
  to: string; // consumer KEY (visual right)
  kind: EdgeKind;
  label: string;
}
/** Visual provider→consumer edges for a spec (provider→app via uses, app→site via env_from, database→
 *  auth via db), with wire labels. Mirrors the server graph endpoint's edge derivation. */
export function specEdges(spec: EditorSpec): EditorGraphEdge[] {
  const out: EditorGraphEdge[] = [];
  for (const [key, res] of Object.entries(spec.resources)) {
    if (res.type === "app")
      for (const u of res.uses ?? []) {
        const target = useTarget(u);
        if (!target || !(target in spec.resources)) continue;
        // (H3) app→app shows the concrete injected env var (<KEY>_URL, the peer key uppercased).
        const label = u.database ? "PG* + CA" : u.bucket ? "S3_*" : u.cache ? "REDIS_URL" : u.auth ? "AUTH_*" : `${target.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
        out.push({ from: target, to: key, kind: "uses", label });
      }
    if (res.type === "site")
      for (const e of res.env_from ?? []) {
        if (!(e.resource in spec.resources)) continue;
        out.push({ from: e.resource, to: key, kind: "env_from", label: e.as });
      }
    if (res.type === "auth" && res.db && res.db in spec.resources) out.push({ from: res.db, to: key, kind: "db", label: "users DB" });
  }
  return out;
}

export interface EditorGraphNode {
  key: string;
  type: ResourceKind;
  siteName: string;
  isNew: boolean; // added in this edit session (no base row yet)
  pendingDelete: boolean;
}
/** Nodes + edges for the editable canvas: applied resources (new ones flagged) plus soft-deleted nodes
 *  (kept visible + flagged, edges suppressed). Pure — the canvas maps this onto @xyflow. */
export function buildEditorGraph(base: EditorSpec, ops: EditorOp[]): { nodes: EditorGraphNode[]; edges: EditorGraphEdge[] } {
  const spec = applyOps(base, ops);
  const pd = new Set(pendingDeleteKeys(base, ops));
  const nodes: EditorGraphNode[] = Object.entries(spec.resources).map(([key, res]) => ({
    key,
    type: res.type,
    siteName: siteNameOf(spec, key, res),
    isNew: !(key in base.resources),
    pendingDelete: false,
  }));
  for (const key of pd) {
    const res = base.resources[key]!;
    nodes.push({ key, type: res.type, siteName: siteNameOf(base, key, res), isNew: false, pendingDelete: true });
  }
  nodes.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { nodes, edges: specEdges(spec) };
}

// ---- cycle detection (mirrors src/stacks/plan.ts dependencies + topoOrder) -----------------------------
/** The keys a resource depends on (must apply first): an app depends on what it `uses`; a site on the
 *  apps it reads `env_from`. Only edges to present keys count. Mirrors plan.ts `dependencies`. */
function dependencies(key: string, resources: Record<string, EditorResource>): string[] {
  const res = resources[key];
  if (!res) return [];
  const out: string[] = [];
  if (res.type === "app") for (const u of res.uses ?? []) { const d = useTarget(u); if (d && resources[d]) out.push(d); }
  if (res.type === "auth" && res.db && resources[res.db]) out.push(res.db); // (K1) auth depends on its database
  if (res.type === "site") for (const e of res.env_from ?? []) if (resources[e.resource]) out.push(e.resource);
  return out;
}
/** Returns the keys forming a dependency cycle, or null when the graph is acyclic (a valid apply order
 *  exists). Same Kahn-style peel as plan.ts topoOrder — the leftover set on stall IS the cycle. */
export function detectCycle(spec: EditorSpec): string[] | null {
  const keys = Object.keys(spec.resources);
  const done = new Set<string>();
  while (done.size < keys.length) {
    const ready = keys.find((k) => !done.has(k) && dependencies(k, spec.resources).every((d) => done.has(d)));
    if (!ready) return keys.filter((k) => !done.has(k)); // stall → the remainder is the cycle
    done.add(ready);
  }
  return null;
}

// ---- validation --------------------------------------------------------------------------------------
/** Advisory client-side field validators (mirror the server sanitizers; the server re-sanitizes on POST).
 *  Return an error string, or null when acceptable. Empty ⇒ null (the field is optional / server-defaulted). */
export const fieldValidators: Record<EditableField, (v: string) => string | null> = {
  image: (v) => (v.trim() === "" || v.length <= 2048 ? null : "image ref too long"),
  storage: (v) => (v.trim() === "" || STORAGE_RE.test(v.trim()) ? null : "use a k8s quantity like 512Mi or 1Gi"),
  memory: (v) => (v.trim() === "" || MEMORY_RE.test(v.trim()) ? null : "use a k8s quantity like 128Mi or 1Gi"),
  persistent: () => null,
  dir: (v) => (v.trim() === "" || v.length <= 1024 ? null : "path too long"),
};

/** The editable fields a form shows for each resource kind. bucket/site carry no minimal field; an auth
 *  resource's only wiring is its `db` (set by dragging, not a form field) and provider config carries
 *  secrets (edited on the detail page, never here) — so it has no in-editor fields either. */
export const FIELDS_FOR: Record<ResourceKind, EditableField[]> = {
  app: ["image"],
  database: ["storage"],
  cache: ["memory", "persistent"],
  site: ["dir"],
  bucket: [],
  auth: [],
};

/** Validate a resource key (mirrors KEY_RE) — a short DNS label, not the stricter site-name rules. */
export function validateKey(key: string): string | null {
  return KEY_RE.test(key) ? null : `invalid key "${key}" — use a short lowercase label (a-z, 0-9, -)`;
}
/** Validate an env-var / ${as} placeholder name (mirrors ENV_NAME_RE). */
export function validateAsName(as: string): string | null {
  return ENV_NAME_RE.test(as) ? null : `invalid name "${as}" — start with a letter/_ then letters, digits, _`;
}

/**
 * Whether `op` may be committed onto `base`+`ops`. Returns an error string (surfaced as a toast), or null.
 * Enforces: key validity + uniqueness, the ≤16 cap, target existence, the legal-edge table, correct target
 * type, duplicate-edge refusal, cycle refusal, and field/${as} validity.
 */
export function validateOp(base: EditorSpec, ops: EditorOp[], op: EditorOp): string | null {
  const spec = applyOps(base, ops);
  switch (op.op) {
    case "addResource": {
      const kerr = validateKey(op.key);
      if (kerr) return kerr;
      if (op.key in spec.resources) return `a resource named "${op.key}" already exists`;
      if (!RESOURCE_KINDS.includes(op.resource.type)) return `unknown resource type "${op.resource.type}"`;
      if (Object.keys(spec.resources).length >= MAX_RESOURCES) return `a stack is limited to ${MAX_RESOURCES} resources`;
      return null;
    }
    case "removeResource":
      return op.key in spec.resources ? null : `no resource "${op.key}" to remove`;
    case "setField": {
      const r = spec.resources[op.key];
      if (!r) return `no resource "${op.key}"`;
      if (!FIELDS_FOR[r.type].includes(op.field)) return `"${op.field}" is not editable on a ${r.type}`;
      if (op.field !== "persistent") return fieldValidators[op.field](String(op.value ?? ""));
      return null;
    }
    case "addEdge": {
      const from = spec.resources[op.from];
      const to = spec.resources[op.to];
      if (!from) return `no resource "${op.from}"`;
      if (!to) return `no resource "${op.to}"`;
      if (op.from === op.to) return "a resource cannot connect to itself";
      const kind = legalEdges(from.type, to.type);
      if (!kind) return `a ${from.type} cannot connect to a ${to.type}`;
      if (kind !== op.kind) return `expected a ${kind} edge, not ${op.kind}`;
      // duplicate?
      if (kind === "uses" && (from.uses ?? []).some((u) => usesTargets(u, op.to))) return `"${op.from}" already uses "${op.to}"`;
      if (kind === "env_from" && (from.env_from ?? []).some((e) => e.resource === op.to)) return `"${op.from}" already reads from "${op.to}"`;
      if (kind === "db" && from.db === op.to) return `"${op.from}" already uses database "${op.to}"`;
      if (op.kind === "env_from") {
        const aerr = validateAsName(op.as ?? "");
        if (aerr) return aerr;
      }
      const cyc = detectCycle(applyOps(base, [...ops, op]));
      if (cyc) return `that connection creates a cycle: ${cyc.join(" → ")}`;
      return null;
    }
    case "removeEdge": {
      const from = spec.resources[op.from];
      if (!from) return `no resource "${op.from}"`;
      const present =
        op.kind === "uses"
          ? (from.uses ?? []).some((u) => usesTargets(u, op.to))
          : op.kind === "db"
            ? from.db === op.to
            : (from.env_from ?? []).some((e) => e.resource === op.to);
      return present ? null : `no ${op.kind} edge from "${op.from}" to "${op.to}"`;
    }
  }
}

// ---- editor state + undo/redo history (pure; StackPage drives it with useState) ------------------------
export interface EditorState {
  baseSpec: EditorSpec;
  baseVersion: number;
  history: EditorOp[][]; // snapshots of the ops list; history[cursor] is current
  cursor: number;
}
export function initEditor(baseSpec: EditorSpec, baseVersion: number): EditorState {
  return { baseSpec: clone(baseSpec), baseVersion, history: [[]], cursor: 0 };
}
export function currentOps(s: EditorState): EditorOp[] {
  return s.history[s.cursor] ?? [];
}
export function isDirty(s: EditorState): boolean {
  return currentOps(s).length > 0;
}
export const canUndo = (s: EditorState): boolean => s.cursor > 0;
export const canRedo = (s: EditorState): boolean => s.cursor < s.history.length - 1;

/** Validate then push a new ops snapshot (truncating any redo future). On error the state is unchanged. */
export function commit(s: EditorState, op: EditorOp): { state: EditorState; error: string | null } {
  const err = validateOp(s.baseSpec, currentOps(s), op);
  if (err) return { state: s, error: err };
  const next = [...currentOps(s), op];
  const history = [...s.history.slice(0, s.cursor + 1), next];
  return { state: { ...s, history, cursor: s.cursor + 1 }, error: null };
}
export function undo(s: EditorState): EditorState {
  return canUndo(s) ? { ...s, cursor: s.cursor - 1 } : s;
}
export function redo(s: EditorState): EditorState {
  return canRedo(s) ? { ...s, cursor: s.cursor + 1 } : s;
}

// ---- rebase (optimistic-lock 409 recovery) -------------------------------------------------------------
export interface DroppedOp {
  op: EditorOp;
  reason: string;
}
/**
 * Replay the current ops onto a freshly-refetched base (after a 409). An op is DROPPED when its target no
 * longer makes sense; the rules are intentionally simple and documented:
 *   addResource  — dropped if the key now exists in newBase (someone else added it).
 *   removeResource — dropped if the key is already gone from newBase (already deleted).
 *   setField     — dropped if the key is gone, OR if newBase changed the same field out from under us
 *                  (newBase value !== the op's recorded `prev`).
 *   addEdge/removeEdge — dropped if either endpoint is gone, the target type no longer fits the edge
 *                  kind, or (addEdge) the edge already exists in newBase.
 * Kept ops are returned in order (still replayable); dropped ops are surfaced so the user can decide.
 */
export function rebase(ops: EditorOp[], newBase: EditorSpec): { ops: EditorOp[]; dropped: DroppedOp[] } {
  const kept: EditorOp[] = [];
  const dropped: DroppedOp[] = [];
  const drop = (op: EditorOp, reason: string) => dropped.push({ op, reason });
  for (const op of ops) {
    // Validate each surviving op against the base-so-far (newBase + kept ops) to stay self-consistent.
    const applied = applyOps(newBase, kept);
    switch (op.op) {
      case "addResource":
        if (op.key in applied.resources) drop(op, `"${op.key}" was created by someone else`);
        else kept.push(op);
        break;
      case "removeResource":
        if (!(op.key in applied.resources)) drop(op, `"${op.key}" was already deleted`);
        else kept.push(op);
        break;
      case "setField": {
        const r = applied.resources[op.key];
        if (!r) { drop(op, `"${op.key}" no longer exists`); break; }
        const upstream = (newBase.resources[op.key] as Record<string, unknown> | undefined)?.[op.field];
        if (op.key in newBase.resources && upstream !== undefined && op.prev !== undefined && upstream !== op.prev) drop(op, `"${op.field}" on "${op.key}" was changed upstream`);
        else kept.push(op);
        break;
      }
      case "addEdge": {
        const from = applied.resources[op.from];
        const to = applied.resources[op.to];
        if (!from || !to) drop(op, `endpoint of the ${op.kind} edge is gone`);
        else if (legalEdges(from.type, to.type) !== op.kind) drop(op, `"${op.from}"→"${op.to}" is no longer a valid ${op.kind} edge`);
        else if (validateOp(newBase, kept, op)) drop(op, `"${op.from}"→"${op.to}" no longer applies`);
        else kept.push(op);
        break;
      }
      case "removeEdge": {
        const from = applied.resources[op.from];
        const present =
          !!from &&
          (op.kind === "uses" ? (from.uses ?? []).some((u) => usesTargets(u, op.to)) : op.kind === "db" ? from.db === op.to : (from.env_from ?? []).some((e) => e.resource === op.to));
        if (!present) drop(op, `${op.kind} edge "${op.from}"→"${op.to}" is already gone`);
        else kept.push(op);
        break;
      }
    }
  }
  return { ops: kept, dropped };
}

/** Rebase an EditorState onto a refetched base+version (409 recovery): keep replayable ops, report drops. */
export function rebaseState(s: EditorState, newBase: EditorSpec, newVersion: number): { state: EditorState; dropped: DroppedOp[] } {
  const { ops, dropped } = rebase(currentOps(s), newBase);
  return { state: { baseSpec: clone(newBase), baseVersion: newVersion, history: [[], ops], cursor: 1 }, dropped };
}
