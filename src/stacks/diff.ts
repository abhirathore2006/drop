// PURE three-way diff for the template "outdated"/"upgrade" flow (D2 — "Dependabot for infra").
// ZERO IO — this is the unit-test asset: table tests feed (templatePinned, templateLatest, current)
// SPECS and assert the exact per-key / per-field classification. Substitution of a stored template
// spec (which carries ${stack}/${var.…} placeholders) into a concrete spec comparable to the stack's
// stored spec is the ROUTE's job (src/api/server.ts) — this module only compares three concrete specs.
//
// The three axes:
//   pinned  = the template@from_template_version spec (the baseline the stack was born from)
//   latest  = the template's newest version spec       (the UPSTREAM axis: pinned → latest)
//   current = the stack's current spec                 (the LOCAL axis:    pinned → current)
//
// A field (or a whole resource) is classified by whether each axis moved off the pinned baseline:
//   unchanged      — neither upstream nor local moved.
//   upstream-only  — upstream moved, local did not          → applied automatically on upgrade.
//   local-only     — local moved (drift), upstream did not  → preserved on upgrade.
//   conflict       — both moved to DIFFERENT values         → needs a per-resource-key resolution.
// (When both moved to the SAME value they have converged → treated as `unchanged`: nothing to do.)
//
// This is deliberately SPEC-LEVEL, per top-level key — NOT a textual merge. The stack spec is small
// and structured; keep it that way (per Plan-v5 §D2).
import type { StackSpec, StackResource } from "../stack-config.ts";

/** Per-field (and the converged both-moved case) three-way classification. */
export type ThreeWayClass = "unchanged" | "upstream-only" | "local-only" | "conflict";

/** A resource's roll-up classification: the three-way class PLUS the add/remove-per-axis cases. */
export type ResourceClass =
  | ThreeWayClass
  | "added-upstream" // new in latest, absent from pinned & current → auto-added
  | "removed-upstream" // dropped upstream, still local & unmodified → auto-removed
  | "added-local" // added locally only (upstream never had it) → preserved
  | "removed-local"; // removed locally (still upstream, upstream unchanged) → stays removed

/** The canvas node badge, from the UPGRADE (pinned → latest) perspective. `conflict` is surfaced
 *  distinctly so the diff view can flag a node that needs a resolution. */
export type DiffBadge = "added" | "removed" | "changed" | "conflict" | "unchanged";

/** One field inside a resource that moved on at least one axis (unchanged fields are omitted). */
export interface FieldDiff {
  field: string;
  class: ThreeWayClass;
  pinned?: unknown;
  latest?: unknown;
  current?: unknown;
}

/** The diff for one top-level resource key. */
export interface ResourceDiff {
  key: string;
  class: ResourceClass;
  /** True → upgrading this key needs the caller to choose take-upstream / keep-local. */
  conflict: boolean;
  /** The canvas badge (upstream perspective). */
  badge: DiffBadge;
  /** Per-field breakdown — only the fields that moved (empty for a pure add/remove). */
  fields: FieldDiff[];
  inPinned: boolean;
  inLatest: boolean;
  inCurrent: boolean;
}

/** The whole three-way diff — the CLI renders it and `upgrade` consumes it. */
export interface StackDiff {
  /** latest differs from pinned in any resource (there is something upstream to pull). */
  upstreamChanged: boolean;
  /** current differs from pinned in any resource (the stack has drifted locally). */
  hasLocalDrift: boolean;
  /** Per top-level key, sorted by key. */
  resources: ResourceDiff[];
  /** Keys with `conflict === true` (upgrade must resolve each). */
  conflicts: string[];
}

/** A per-resource-key upgrade resolution. */
export type Resolution = "take-upstream" | "keep-local";

/** The merged spec `upgrade` feeds to the standard reconcile, plus what it did. */
export interface UpgradeMerge {
  /** The merged desired spec (base = current, with non-conflicting upstream changes applied). */
  spec: StackSpec;
  /** Keys where non-conflicting upstream changes were applied automatically. */
  autoApplied: string[];
  /** Conflict keys resolved by an explicit resolution. */
  resolved: { key: string; how: Resolution }[];
  /** Conflict keys with NO resolution supplied — a non-empty list must 409 (do not apply). */
  unresolved: string[];
}

// ---- deterministic deep-equality (order-insensitive object keys) --------------------------------
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
const canon = (v: unknown): string => JSON.stringify(sortKeys(v)) ?? "undefined";
const eq = (a: unknown, b: unknown): boolean => canon(a) === canon(b);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Per-field three-way diff between three resource objects (any may be undefined → treated as `{}`). */
function fieldDiffs(p: StackResource | undefined, l: StackResource | undefined, c: StackResource | undefined): FieldDiff[] {
  const pr = (p ?? {}) as Record<string, unknown>;
  const lr = (l ?? {}) as Record<string, unknown>;
  const cr = (c ?? {}) as Record<string, unknown>;
  const fields = new Set<string>([...Object.keys(pr), ...Object.keys(lr), ...Object.keys(cr)]);
  const out: FieldDiff[] = [];
  for (const f of [...fields].sort()) {
    const pv = pr[f];
    const lv = lr[f];
    const cv = cr[f];
    const upstreamMoved = !eq(pv, lv);
    const localMoved = !eq(pv, cv);
    let cls: ThreeWayClass;
    if (!upstreamMoved && !localMoved) cls = "unchanged";
    else if (upstreamMoved && !localMoved) cls = "upstream-only";
    else if (!upstreamMoved && localMoved) cls = "local-only";
    else cls = eq(lv, cv) ? "unchanged" : "conflict"; // both moved: converged → unchanged, else conflict
    if (cls !== "unchanged") out.push({ field: f, class: cls, pinned: pv, latest: lv, current: cv });
  }
  return out;
}

/** Classify one top-level resource key across the three axes. */
function diffResource(key: string, p: StackResource | undefined, l: StackResource | undefined, c: StackResource | undefined): ResourceDiff {
  const inPinned = p !== undefined;
  const inLatest = l !== undefined;
  const inCurrent = c !== undefined;
  const fields = fieldDiffs(p, l, c);
  const base = { key, fields, inPinned, inLatest, inCurrent };

  // --- not in the pinned baseline: an addition on one or both live axes -------------------------
  if (!inPinned) {
    if (inLatest && inCurrent) {
      // added on BOTH sides: converged → nothing to do; diverged → a conflict.
      if (eq(l, c)) return { ...base, class: "unchanged", conflict: false, badge: "unchanged", fields: [] };
      return { ...base, class: "conflict", conflict: true, badge: "conflict" };
    }
    if (inLatest) return { ...base, class: "added-upstream", conflict: false, badge: "added", fields: [] };
    return { ...base, class: "added-local", conflict: false, badge: "unchanged", fields: [] }; // inCurrent only
  }

  // --- in the pinned baseline -------------------------------------------------------------------
  const upstreamMoved = !eq(p, l);
  const localMoved = !eq(p, c);

  if (inLatest && inCurrent) {
    // present everywhere → roll up the per-field classes.
    const anyConflict = fields.some((f) => f.class === "conflict");
    const anyUpstream = fields.some((f) => f.class === "upstream-only");
    const anyLocal = fields.some((f) => f.class === "local-only");
    const cls: ResourceClass = anyConflict ? "conflict" : anyUpstream ? "upstream-only" : anyLocal ? "local-only" : "unchanged";
    const badge: DiffBadge = anyConflict ? "conflict" : anyUpstream ? "changed" : "unchanged"; // a local-only change is not an upstream badge
    return { ...base, class: cls, conflict: anyConflict, badge };
  }

  if (inLatest && !inCurrent) {
    // removed LOCALLY, still upstream. If upstream ALSO moved it → conflict (upstream modified, local deleted).
    if (upstreamMoved) return { ...base, class: "conflict", conflict: true, badge: "conflict" };
    return { ...base, class: "removed-local", conflict: false, badge: "unchanged", fields: [] };
  }

  if (!inLatest && inCurrent) {
    // removed UPSTREAM, still local. Unmodified local → auto-remove; locally modified → conflict.
    if (localMoved) return { ...base, class: "conflict", conflict: true, badge: "conflict" };
    return { ...base, class: "removed-upstream", conflict: false, badge: "removed", fields: [] };
  }

  // pinned only (removed on BOTH axes) — final state already matches (absent): nothing to do.
  return { ...base, class: "unchanged", conflict: false, badge: "unchanged", fields: [] };
}

/**
 * Three-way diff of three CONCRETE stack specs. `templatePinned`/`templateLatest` must already be
 * substituted (the route resolves ${stack}/${var.…} and lifts secrets so they compare like the stored
 * stack spec). The top-level `name` is intentionally ignored — a stack always carries its own name.
 */
export function diffStack(templatePinned: StackSpec, templateLatest: StackSpec, current: StackSpec): StackDiff {
  const keys = new Set<string>([...Object.keys(templatePinned.resources), ...Object.keys(templateLatest.resources), ...Object.keys(current.resources)]);
  const resources: ResourceDiff[] = [];
  for (const key of [...keys].sort()) {
    resources.push(diffResource(key, templatePinned.resources[key], templateLatest.resources[key], current.resources[key]));
  }
  const conflicts = resources.filter((r) => r.conflict).map((r) => r.key);
  return {
    upstreamChanged: !eq(templatePinned.resources, templateLatest.resources),
    hasLocalDrift: !eq(templatePinned.resources, current.resources),
    resources,
    conflicts,
  };
}

/**
 * Merge an upgrade: base = the stack's `current` spec, onto which NON-CONFLICTING upstream changes are
 * applied automatically (added / removed resources; upstream-only field deltas — preserving local drift).
 * A conflicted key is applied ONLY if a resolution is supplied: `take-upstream` swaps in the latest
 * resource wholesale, `keep-local` keeps the current one wholesale (per top-level key — not a textual
 * merge). Conflict keys with no resolution land in `unresolved` (the route 409s; the spec is not applied).
 */
export function mergeUpgrade(diff: StackDiff, latest: StackSpec, current: StackSpec, resolutions: Record<string, Resolution> = {}): UpgradeMerge {
  const resources: Record<string, StackResource> = clone(current.resources);
  const autoApplied: string[] = [];
  const resolved: { key: string; how: Resolution }[] = [];
  const unresolved: string[] = [];

  const takeUpstream = (key: string) => {
    if (latest.resources[key]) resources[key] = clone(latest.resources[key]!);
    else delete resources[key];
  };
  const keepLocal = (key: string) => {
    if (current.resources[key]) resources[key] = clone(current.resources[key]!);
    else delete resources[key];
  };

  for (const rd of diff.resources) {
    if (rd.conflict) {
      const how = resolutions[rd.key];
      if (!how) {
        unresolved.push(rd.key); // leave the base (current) untouched
        continue;
      }
      if (how === "take-upstream") takeUpstream(rd.key);
      else keepLocal(rd.key);
      resolved.push({ key: rd.key, how });
      continue;
    }
    switch (rd.class) {
      case "added-upstream":
        takeUpstream(rd.key);
        autoApplied.push(rd.key);
        break;
      case "removed-upstream":
        delete resources[rd.key];
        autoApplied.push(rd.key);
        break;
      case "upstream-only": {
        // apply ONLY the upstream-only field deltas onto the local resource — local-only drift is preserved.
        const target = resources[rd.key] as unknown as Record<string, unknown> | undefined;
        if (target) {
          for (const f of rd.fields) {
            if (f.class !== "upstream-only") continue;
            if (f.latest === undefined) delete target[f.field];
            else target[f.field] = clone(f.latest);
          }
        }
        autoApplied.push(rd.key);
        break;
      }
      // local-only / added-local / removed-local / unchanged → the base (current) is already correct.
      default:
        break;
    }
  }
  return { spec: { name: current.name, resources }, autoApplied, resolved, unresolved };
}
