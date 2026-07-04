// LOCKSTEP: the console's legal-edge table (lib/stack-editor.ts legalEdges) is DERIVED from — and locked
// to — the server's real edge authority (src/stack-config.ts). Node-side test (plain bun test = real
// Node/Bun, not the browser bundle), so importing the real server module is fine — same pattern as
// validateName.test.ts. If src/stack-config.ts gains a new edge kind (e.g. app→auth), the derived
// ground-truth below picks it up and this test fails until legalEdges is updated to match.
import { describe, expect, test } from "bun:test";
import { sanitizeStackConfig, validateStackEdges, type StackResource, type StackSpec, type StackResourceKind } from "../../../src/stack-config.ts";
import { applyOps, legalEdges, RESOURCE_KINDS, type EdgeKind, type EditorSpec, type ResourceKind } from "./stack-editor.ts";

// The kinds the sanitizer actually accepts, discovered by probing it (so a NEW kind added server-side is
// picked up automatically rather than silently skipped). Probed over a superset that includes not-yet-real
// candidates like "auth".
const CANDIDATE_TYPES: string[] = ["site", "app", "database", "bucket", "cache", "auth", "secret", "queue"];
const KINDS = CANDIDATE_TYPES.filter((t) => sanitizeStackConfig({ name: "s", resources: { x: { type: t } } })?.resources.x?.type === t) as StackResourceKind[];

// A minimal resource of a kind that survives sanitizeStackConfig.
const res = (type: StackResourceKind): Record<string, unknown> => ({ type });

// Every binding shape a consumer of type `fromType` can express toward a provider of type `toType`,
// keyed the way the server keys them: an app's `uses` slot is named by the PROVIDER type (database/
// bucket/cache/auth/…); a site's `env_from` references an app; a K1 auth's scalar `db` references a
// database. Generalizing the uses slot to the provider's type name means a brand-new provider kind
// (uses:[{X:…}]) is probed without editing this test.
function candidateBindings(toType: StackResourceKind): { kind: EdgeKind; make: (target: string) => Record<string, unknown> }[] {
  return [
    { kind: "uses", make: (t) => ({ uses: [{ [toType]: t }] }) },
    { kind: "env_from", make: (t) => ({ env_from: [{ resource: t, output: "url", as: "X" }] }) },
    { kind: "db", make: (t) => ({ db: t }) },
  ];
}

// An auth resource has its OWN hard requirement (a valid `db`), which would otherwise make validateStackEdges
// reject every spec that merely CONTAINS an auth (masking the edge under test). So give any auth resource a
// valid db → a helper database — UNLESS its db is already the binding under test.
function withAuthDbs(resources: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const r: Record<string, Record<string, unknown>> = JSON.parse(JSON.stringify(resources));
  let added = false;
  for (const k of Object.keys(r)) {
    if (r[k]!.type === "auth" && !r[k]!.db) {
      r[k]!.db = "hdb";
      added = true;
    }
  }
  if (added && !r.hdb) r.hdb = res("database");
  return r;
}

// The ground-truth legal edge kind for (fromType → toType), derived PURELY from the server modules:
// a binding counts as a real, legal, typed edge iff (a) it survives the sanitizer on the consumer (the
// field is kept for that resource type), (b) validateStackEdges ACCEPTS it with the right-typed target,
// and (c) validateStackEdges REJECTS it when the target key is absent (proving it's actually referenced,
// not an ignored stray field).
function serverLegal(fromType: StackResourceKind, toType: StackResourceKind): EdgeKind | null {
  for (const b of candidateBindings(toType)) {
    const good = sanitizeStackConfig({ name: "s", resources: withAuthDbs({ c: { ...res(fromType), ...b.make("t") }, t: res(toType) }) });
    if (!good) continue;
    const c = good.resources.c as StackResource;
    const survived = b.kind === "uses" ? (c.uses?.length ?? 0) > 0 : b.kind === "db" ? !!c.db && c.db === "t" : (c.env_from?.length ?? 0) > 0;
    if (!survived) continue; // sanitizer stripped it → not a valid field for this consumer type
    if (validateStackEdges(good) !== null) continue; // server rejects the correct-typed edge → not legal
    const missing = sanitizeStackConfig({ name: "s", resources: withAuthDbs({ c: { ...res(fromType), ...b.make("nope") }, t: res(toType) }) });
    if (missing && validateStackEdges(missing) === null) continue; // absent target not rejected → stray field, not a real edge
    return b.kind;
  }
  return null;
}

describe("legalEdges is locked to src/stack-config.ts", () => {
  test("the console's KIND set matches the sanitizer's accepted kinds", () => {
    // If this fails, a resource kind was added/removed server-side — update RESOURCE_KINDS + legalEdges.
    expect([...RESOURCE_KINDS].sort()).toEqual([...KINDS].sort() as ResourceKind[]);
  });

  for (const from of KINDS)
    for (const to of KINDS) {
      test(`edge ${from} → ${to} agrees with the server`, () => {
        expect(legalEdges(from as ResourceKind, to as ResourceKind)).toBe(serverLegal(from, to));
      });
    }
});

describe("every edge legalEdges permits is accepted by validateStackEdges (positive lockstep)", () => {
  for (const from of KINDS)
    for (const to of KINDS) {
      const kind = legalEdges(from as ResourceKind, to as ResourceKind);
      if (!kind) continue;
      test(`applyOps(addEdge ${from}→${to}) passes validateStackEdges`, () => {
        // Any auth resource in the fixture needs a valid db to satisfy its own hard requirement.
        const resources = withAuthDbs({ c: { type: from }, t: { type: to } });
        const spec = { name: "s", resources } as unknown as EditorSpec;
        const sent = applyOps(spec, [{ op: "addEdge", from: "c", to: "t", kind, as: "X" }]);
        // round-trip through the real sanitizer, then the real edge validator: no error.
        const sane = sanitizeStackConfig(sent as unknown as StackSpec)!;
        expect(sane).toBeDefined();
        expect(validateStackEdges(sane)).toBeNull();
      });
    }
});
