import { test, expect, describe } from "bun:test";
import { diffStack, mergeUpgrade, type StackDiff, type Resolution } from "./diff.ts";
import type { StackSpec, StackResource } from "../stack-config.ts";

// Table-test asset: (pinned, latest, current) → exact classification. Specs here are CONCRETE (the route
// substitutes ${stack}/${var.…} before calling diffStack, so the pure diff only ever sees concrete specs).
const spec = (resources: Record<string, StackResource>): StackSpec => ({ name: "shop", resources });
const db = (storage = "1Gi"): StackResource => ({ type: "database", storage, hibernation: "none" });
const app = (extra: Partial<StackResource> = {}): StackResource => ({ type: "app", image: "web:1", ...extra });

const byKey = (d: StackDiff) => Object.fromEntries(d.resources.map((r) => [r.key, r]));

describe("diffStack — per-resource classification", () => {
  test("unchanged: all three identical", () => {
    const s = spec({ db: db(), web: app() });
    const d = diffStack(s, s, s);
    expect(d.upstreamChanged).toBe(false);
    expect(d.hasLocalDrift).toBe(false);
    expect(d.conflicts).toEqual([]);
    expect(byKey(d).db!.class).toBe("unchanged");
    expect(byKey(d).db!.badge).toBe("unchanged");
    expect(byKey(d).web!.fields).toEqual([]);
  });

  test("pure upstream change: latest moved a field, current still == pinned → upstream-only", () => {
    const pinned = spec({ db: db("1Gi") });
    const latest = spec({ db: db("2Gi") });
    const current = spec({ db: db("1Gi") });
    const d = diffStack(pinned, latest, current);
    expect(d.upstreamChanged).toBe(true);
    expect(d.hasLocalDrift).toBe(false);
    const r = byKey(d).db!;
    expect(r.class).toBe("upstream-only");
    expect(r.conflict).toBe(false);
    expect(r.badge).toBe("changed");
    expect(r.fields).toEqual([{ field: "storage", class: "upstream-only", pinned: "1Gi", latest: "2Gi", current: "1Gi" }]);
  });

  test("pure local drift: current moved a field, latest still == pinned → local-only (badge unchanged)", () => {
    const pinned = spec({ db: db("1Gi") });
    const latest = spec({ db: db("1Gi") });
    const current = spec({ db: db("5Gi") });
    const d = diffStack(pinned, latest, current);
    expect(d.upstreamChanged).toBe(false);
    expect(d.hasLocalDrift).toBe(true);
    const r = byKey(d).db!;
    expect(r.class).toBe("local-only");
    expect(r.conflict).toBe(false);
    expect(r.badge).toBe("unchanged"); // local drift is NOT an upstream badge
    expect(r.fields).toEqual([{ field: "storage", class: "local-only", pinned: "1Gi", latest: "1Gi", current: "5Gi" }]);
  });

  test("conflict: upstream and local moved the SAME field to DIFFERENT values", () => {
    const pinned = spec({ db: db("1Gi") });
    const latest = spec({ db: db("2Gi") });
    const current = spec({ db: db("5Gi") });
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).db!;
    expect(r.class).toBe("conflict");
    expect(r.conflict).toBe(true);
    expect(r.badge).toBe("conflict");
    expect(d.conflicts).toEqual(["db"]);
    expect(r.fields[0]!.class).toBe("conflict");
  });

  test("converged: upstream and local moved the SAME field to the SAME value → unchanged, no conflict", () => {
    const pinned = spec({ db: db("1Gi") });
    const latest = spec({ db: db("2Gi") });
    const current = spec({ db: db("2Gi") });
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).db!;
    expect(r.conflict).toBe(false);
    expect(r.class).toBe("unchanged");
    expect(r.fields).toEqual([]);
  });

  test("added-upstream: new resource in latest, absent from pinned & current", () => {
    const pinned = spec({ web: app() });
    const latest = spec({ web: app(), cache: { type: "cache", memory: "256Mi", persistent: false } });
    const current = spec({ web: app() });
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).cache!;
    expect(r.class).toBe("added-upstream");
    expect(r.conflict).toBe(false);
    expect(r.badge).toBe("added");
    expect(d.upstreamChanged).toBe(true);
  });

  test("removed-upstream (local unmodified): dropped in latest, current still == pinned → auto-removable", () => {
    const pinned = spec({ web: app(), old: db() });
    const latest = spec({ web: app() });
    const current = spec({ web: app(), old: db() });
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).old!;
    expect(r.class).toBe("removed-upstream");
    expect(r.conflict).toBe(false);
    expect(r.badge).toBe("removed");
  });

  test("removed-upstream but locally MODIFIED → conflict", () => {
    const pinned = spec({ web: app(), old: db("1Gi") });
    const latest = spec({ web: app() });
    const current = spec({ web: app(), old: db("9Gi") }); // local changed the doomed resource
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).old!;
    expect(r.class).toBe("conflict");
    expect(r.conflict).toBe(true);
    expect(d.conflicts).toEqual(["old"]);
  });

  test("added-local: added only in current (upstream never had it) → preserved, no upstream badge", () => {
    const pinned = spec({ web: app() });
    const latest = spec({ web: app() });
    const current = spec({ web: app(), extra: { type: "bucket" } });
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).extra!;
    expect(r.class).toBe("added-local");
    expect(r.conflict).toBe(false);
    expect(r.badge).toBe("unchanged");
    expect(d.hasLocalDrift).toBe(true);
  });

  test("removed-local (upstream unchanged): removed in current, still in latest unchanged → stays removed", () => {
    const pinned = spec({ web: app(), gone: db() });
    const latest = spec({ web: app(), gone: db() });
    const current = spec({ web: app() });
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).gone!;
    expect(r.class).toBe("removed-local");
    expect(r.conflict).toBe(false);
  });

  test("removed-local but upstream MODIFIED it → conflict (upstream changed, local deleted)", () => {
    const pinned = spec({ web: app(), svc: db("1Gi") });
    const latest = spec({ web: app(), svc: db("4Gi") }); // upstream changed the resource
    const current = spec({ web: app() }); // local deleted it
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).svc!;
    expect(r.class).toBe("conflict");
    expect(r.conflict).toBe(true);
  });

  test("added on BOTH sides identically → unchanged; differently → conflict", () => {
    const pinned = spec({ web: app() });
    const same = diffStack(pinned, spec({ web: app(), c: db("1Gi") }), spec({ web: app(), c: db("1Gi") }));
    expect(byKey(same).c!.class).toBe("unchanged");
    expect(byKey(same).c!.conflict).toBe(false);
    const diff = diffStack(pinned, spec({ web: app(), c: db("1Gi") }), spec({ web: app(), c: db("2Gi") }));
    expect(byKey(diff).c!.class).toBe("conflict");
    expect(byKey(diff).c!.conflict).toBe(true);
  });

  test("field-level within a resource: one field upstream-only, another local-only, no field conflict → auto-mergeable", () => {
    const pinned = spec({ web: app({ image: "web:1", scale: { min: 1, max: 3 } }) });
    const latest = spec({ web: app({ image: "web:2", scale: { min: 1, max: 3 } }) }); // upstream bumped image
    const current = spec({ web: app({ image: "web:1", scale: { min: 2, max: 3 } }) }); // local bumped scale.min
    const d = diffStack(pinned, latest, current);
    const r = byKey(d).web!;
    expect(r.conflict).toBe(false);
    expect(r.class).toBe("upstream-only"); // roll-up: has an upstream field change, no conflict
    const fieldClasses = Object.fromEntries(r.fields.map((f) => [f.field, f.class]));
    expect(fieldClasses.image).toBe("upstream-only");
    expect(fieldClasses.scale).toBe("local-only");
  });

  test("key ordering is deterministic (sorted)", () => {
    const s = spec({ zeta: app(), alpha: db(), mid: { type: "bucket" } });
    const d = diffStack(s, s, s);
    expect(d.resources.map((r) => r.key)).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("mergeUpgrade — auto-apply, conflict gating, resolutions", () => {
  test("non-conflicting upstream change is auto-applied; local-only drift is preserved", () => {
    const pinned = spec({ web: app({ image: "web:1", scale: { min: 1, max: 3 } }) });
    const latest = spec({ web: app({ image: "web:2", scale: { min: 1, max: 3 } }) });
    const current = spec({ web: app({ image: "web:1", scale: { min: 2, max: 3 } }) });
    const d = diffStack(pinned, latest, current);
    const m = mergeUpgrade(d, latest, current);
    expect(m.unresolved).toEqual([]);
    expect(m.autoApplied).toEqual(["web"]);
    // upstream image bump applied, local scale.min preserved
    expect(m.spec.resources.web!.image).toBe("web:2");
    expect(m.spec.resources.web!.scale).toEqual({ min: 2, max: 3 });
    expect(m.spec.name).toBe("shop");
  });

  test("added-upstream resource auto-added; removed-upstream auto-removed", () => {
    const pinned = spec({ web: app(), old: db() });
    const latest = spec({ web: app(), cache: { type: "cache", memory: "256Mi", persistent: false } });
    const current = spec({ web: app(), old: db() });
    const d = diffStack(pinned, latest, current);
    const m = mergeUpgrade(d, latest, current);
    expect(m.unresolved).toEqual([]);
    expect(Object.keys(m.spec.resources).sort()).toEqual(["cache", "web"]); // old removed, cache added
    expect(m.autoApplied.sort()).toEqual(["cache", "old"]);
  });

  test("a conflict with NO resolution → unresolved, spec left untouched (route 409s)", () => {
    const pinned = spec({ db: db("1Gi") });
    const latest = spec({ db: db("2Gi") });
    const current = spec({ db: db("5Gi") });
    const d = diffStack(pinned, latest, current);
    const m = mergeUpgrade(d, latest, current);
    expect(m.unresolved).toEqual(["db"]);
    expect(m.resolved).toEqual([]);
    expect(m.spec.resources.db!.storage).toBe("5Gi"); // unchanged — the caller must resolve first
  });

  test("resolution honored both ways: take-upstream vs keep-local", () => {
    const pinned = spec({ db: db("1Gi") });
    const latest = spec({ db: db("2Gi") });
    const current = spec({ db: db("5Gi") });
    const d = diffStack(pinned, latest, current);

    const takeUp = mergeUpgrade(d, latest, current, { db: "take-upstream" as Resolution });
    expect(takeUp.unresolved).toEqual([]);
    expect(takeUp.resolved).toEqual([{ key: "db", how: "take-upstream" }]);
    expect(takeUp.spec.resources.db!.storage).toBe("2Gi");

    const keepLocal = mergeUpgrade(d, latest, current, { db: "keep-local" as Resolution });
    expect(keepLocal.unresolved).toEqual([]);
    expect(keepLocal.spec.resources.db!.storage).toBe("5Gi");
  });

  test("conflict = upstream removed / local modified: take-upstream removes, keep-local keeps", () => {
    const pinned = spec({ web: app(), old: db("1Gi") });
    const latest = spec({ web: app() });
    const current = spec({ web: app(), old: db("9Gi") });
    const d = diffStack(pinned, latest, current);
    expect(d.conflicts).toEqual(["old"]);

    const takeUp = mergeUpgrade(d, latest, current, { old: "take-upstream" });
    expect(takeUp.spec.resources.old).toBeUndefined(); // upstream wants it gone

    const keepLocal = mergeUpgrade(d, latest, current, { old: "keep-local" });
    expect(keepLocal.spec.resources.old!.storage).toBe("9Gi"); // keep the locally-modified one
  });

  test("mixed batch: one auto-apply + one conflict → only the conflict blocks", () => {
    const pinned = spec({ db: db("1Gi"), web: app({ image: "web:1" }) });
    const latest = spec({ db: db("2Gi"), web: app({ image: "web:2" }) }); // db upstream-only, web upstream-only
    const current = spec({ db: db("5Gi"), web: app({ image: "web:1" }) }); // db drifted → conflict; web clean
    const d = diffStack(pinned, latest, current);
    const m = mergeUpgrade(d, latest, current); // no resolution for db
    expect(m.unresolved).toEqual(["db"]);
    expect(m.autoApplied).toEqual(["web"]); // web still auto-applied
    expect(m.spec.resources.web!.image).toBe("web:2");
    // once db is resolved, nothing is unresolved
    const m2 = mergeUpgrade(d, latest, current, { db: "take-upstream" });
    expect(m2.unresolved).toEqual([]);
    expect(m2.spec.resources.db!.storage).toBe("2Gi");
  });
});
