// PURE diff + toposort for `drop up`. Given the desired stack spec, the last-applied spec, the
// previously-materialized key→site_name mapping, and which site names currently exist live, produce
// the exact ordered list of reconcile steps. ZERO IO — this is the unit-test asset (table tests feed
// (spec, live) and assert the exact ordered steps). The API route (src/api/server.ts) is the only
// thing that performs the steps; the planner never touches the metastore or the cluster.
import type { StackSpec, StackResource, StackResourceKind } from "../stack-config.ts";
import { resolveResourceName } from "../stack-config.ts";

/** What currently exists for a site name (from a metastore lookup at plan time). */
export interface LivePresence {
  type: StackResourceKind;
}

/** One reconcile step. `siteName` is the materialized name; `reason` is human-facing (plan table). */
export interface PlanStep {
  action: "create" | "update" | "delete" | "noop";
  key: string;
  kind: StackResourceKind;
  siteName: string;
  reason: string;
}

export interface PlanInput {
  spec: StackSpec; // desired state (this `up`)
  prevSpec?: StackSpec | null; // last-applied spec (for noop detection); null on a first `up`
  mapping?: Record<string, string>; // resource_key -> site_name previously materialized (stack_resources)
  live?: Record<string, LivePresence>; // site_name -> what exists now (metastore)
  prune?: boolean; // affects only the DELETE steps' reason text (execution is the route's call)
}

/** Thrown when the desired spec's edges form a cycle (db→app→…→db) — no valid apply order exists. */
export class StackCycleError extends Error {
  readonly name = "StackCycleError";
  constructor(readonly cycleKeys: string[]) {
    super(`stack has a dependency cycle: ${cycleKeys.join(" → ")}`);
  }
}

/** The keys a resource depends on (must be applied FIRST): an app depends on the databases it `uses`;
 *  a site depends on the apps it reads `env_from`. Only edges to keys present in `resources` count. */
function dependencies(key: string, resources: Record<string, StackResource>): string[] {
  const res = resources[key];
  if (!res) return [];
  const out: string[] = [];
  if (res.type === "app")
    for (const u of res.uses ?? []) {
      const dep = u.database ?? u.bucket ?? u.cache; // an app depends on the databases, buckets AND caches it `uses`
      if (dep && resources[dep]) out.push(dep);
    }
  if (res.type === "site") for (const e of res.env_from ?? []) if (resources[e.resource]) out.push(e.resource);
  return out;
}

/**
 * Deterministic topological sort: dependencies first (databases → apps → sites). Ties break by the
 * key's insertion order in the spec, so the step list is stable across runs (exact-match table tests).
 * Throws StackCycleError when no valid order exists.
 */
function topoOrder(resources: Record<string, StackResource>): string[] {
  const keys = Object.keys(resources);
  const index = new Map(keys.map((k, i) => [k, i] as const));
  const done = new Set<string>();
  const out: string[] = [];
  while (out.length < keys.length) {
    // Among not-yet-emitted keys whose deps are all emitted, pick the earliest by insertion order.
    let pick: string | null = null;
    for (const k of keys) {
      if (done.has(k)) continue;
      if (dependencies(k, resources).every((d) => done.has(d))) {
        if (pick === null || index.get(k)! < index.get(pick)!) pick = k;
      }
    }
    if (pick === null) {
      // No key is ready → a cycle among the remaining keys. Surface the remainder for the message.
      throw new StackCycleError(keys.filter((k) => !done.has(k)));
    }
    done.add(pick);
    out.push(pick);
  }
  return out;
}

/** Stable JSON (object keys sorted) so two resource specs compare equal regardless of key order. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
}
const sameResource = (a: StackResource, b: StackResource): boolean => stable(a) === stable(b);

/**
 * Diff the desired spec against previous state → ordered steps.
 *   create : key in spec, its site is NOT live.
 *   noop   : key in spec, site is live, and its config is unchanged vs the last-applied spec.
 *   update : key in spec, site is live, but new (or changed, or newly-adopted) config.
 *   delete : key previously managed (in mapping or prevSpec) but absent from the new spec. Ordered in
 *            REVERSE (dependents before their dependencies) so we never drop a db an app still uses.
 * create/update/noop come first (dependencies first); deletes come last (dependents first).
 */
export function planStack(input: PlanInput): PlanStep[] {
  const { spec } = input;
  const prev = input.prevSpec ?? null;
  const mapping = input.mapping ?? {};
  const live = input.live ?? {};
  const steps: PlanStep[] = [];

  const nameOf = (key: string, res: StackResource) => mapping[key] ?? resolveResourceName(spec.name, key, res);

  for (const key of topoOrder(spec.resources)) {
    const res = spec.resources[key]!;
    const siteName = nameOf(key, res);
    if (live[siteName] === undefined) {
      steps.push({ action: "create", key, kind: res.type, siteName, reason: "not present — will create" });
      continue;
    }
    const prevRes = prev?.resources[key];
    if (prevRes && sameResource(prevRes, res)) {
      steps.push({ action: "noop", key, kind: res.type, siteName, reason: "unchanged" });
    } else {
      steps.push({ action: "update", key, kind: res.type, siteName, reason: prevRes ? "config changed" : "adopting existing resource" });
    }
  }

  // Removed keys: previously managed (prev spec or the mapping) but gone from the new spec.
  const removed = new Set<string>();
  for (const k of Object.keys(prev?.resources ?? {})) if (!(k in spec.resources)) removed.add(k);
  for (const k of Object.keys(mapping)) if (!(k in spec.resources)) removed.add(k);
  if (removed.size) {
    // Order dependents-before-dependencies: topo of the PREV spec (acyclic — it was applied), reversed.
    let order: string[];
    try {
      order = prev ? topoOrder(prev.resources).filter((k) => removed.has(k)).reverse() : [...removed];
    } catch {
      order = [...removed]; // defensive: a malformed prev spec never blocks a delete plan
    }
    for (const k of order) {
      const prevRes = prev?.resources[k];
      const siteName = mapping[k] ?? (prev && prevRes ? resolveResourceName(prev.name, k, prevRes) : k);
      const kind: StackResourceKind = prevRes?.type ?? live[siteName]?.type ?? "app";
      const reason = input.prune
        ? "removed from spec — pruning"
        : "flagged-delete — no longer in spec (pass --prune to remove)";
      steps.push({ action: "delete", key: k, kind, siteName, reason });
    }
  }

  return steps;
}
