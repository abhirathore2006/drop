// Pure tests for the C2 editor model (no DOM): ops apply/validate, the legal-edge table, cycle
// detection, the ≤16 cap, undo/redo history, and the rebase conflict rules. This is the bulk of the
// slice's test asset — the UI is a thin skin over these functions.
import { describe, expect, test } from "bun:test";
import {
  applyOps,
  buildEditorGraph,
  canRedo,
  canUndo,
  commit,
  currentOps,
  detectCycle,
  edgeSemantic,
  initEditor,
  isDirty,
  legalEdges,
  MAX_RESOURCES,
  newResource,
  pendingDeleteKeys,
  rebase,
  rebaseState,
  redo,
  specEdges,
  suggestKey,
  undo,
  validateAsName,
  validateKey,
  validateOp,
  type EditorOp,
  type EditorSpec,
} from "./stack-editor.ts";

const base = (): EditorSpec => ({
  name: "shop",
  resources: {
    db: { type: "database", storage: "1Gi" },
    api: { type: "app", image: "ghcr.io/x/api:1", uses: [{ database: "db" }] },
    web: { type: "site", env_from: [{ resource: "api", output: "url", as: "API_URL" }] },
  },
});

describe("legalEdges (the derived table)", () => {
  test("app→{database,cache,bucket,auth,app} = uses; site→app = env_from; auth→database = db; else null", () => {
    expect(legalEdges("app", "database")).toBe("uses");
    expect(legalEdges("app", "cache")).toBe("uses");
    expect(legalEdges("app", "bucket")).toBe("uses");
    expect(legalEdges("app", "auth")).toBe("uses"); // (K1)
    expect(legalEdges("app", "app")).toBe("uses"); // (H3) service discovery
    expect(legalEdges("site", "app")).toBe("env_from");
    expect(legalEdges("auth", "database")).toBe("db"); // (K1) scalar required binding
    // illegal
    expect(legalEdges("database", "database")).toBeNull();
    expect(legalEdges("app", "site")).toBeNull();
    expect(legalEdges("site", "site")).toBeNull();
    expect(legalEdges("site", "database")).toBeNull();
    expect(legalEdges("database", "app")).toBeNull();
    expect(legalEdges("auth", "app")).toBeNull();
    expect(legalEdges("auth", "cache")).toBeNull();
  });
  test("semantic labels for the inline magnet", () => {
    expect(edgeSemantic("app", "database")).toBe("injects PG* + CA");
    expect(edgeSemantic("app", "cache")).toBe("injects REDIS_URL");
    expect(edgeSemantic("app", "bucket")).toBe("injects S3_*");
    expect(edgeSemantic("app", "auth")).toBe("injects AUTH_URL + AUTH_JWT_SECRET");
    expect(edgeSemantic("app", "app")).toBe("injects <KEY>_URL"); // (H3)
    expect(edgeSemantic("site", "app", "API_URL")).toBe("injects API_URL");
    expect(edgeSemantic("auth", "database")).toBe("auth engine + users live here");
  });
});

describe("applyOps", () => {
  test("does not mutate the base spec (purity)", () => {
    const b = base();
    const snapshot = JSON.stringify(b);
    applyOps(b, [{ op: "addResource", key: "cache", resource: newResource("cache") }]);
    expect(JSON.stringify(b)).toBe(snapshot);
  });

  test("addResource adds a node; setField edits a type field", () => {
    const spec = applyOps(base(), [
      { op: "addResource", key: "cache", resource: newResource("cache") },
      { op: "setField", key: "cache", field: "memory", value: "512Mi" },
    ]);
    expect(spec.resources.cache).toEqual({ type: "cache", memory: "512Mi", persistent: false });
  });

  test("addEdge writes the right uses slot / env_from entry", () => {
    const b = base();
    const withCache = applyOps(b, [
      { op: "addResource", key: "cache", resource: newResource("cache") },
      { op: "addEdge", from: "api", to: "cache", kind: "uses" },
    ]);
    expect(withCache.resources.api!.uses).toContainEqual({ cache: "cache" });
    // env_from with an explicit AS
    const withSite = applyOps(b, [{ op: "addEdge", from: "web", to: "api", kind: "env_from", as: "BACKEND" }]);
    expect(withSite.resources.web!.env_from).toContainEqual({ resource: "api", output: "url", as: "BACKEND" });
  });

  test("removeResource drops the key AND prunes edges that pointed at it (edge-sound send spec)", () => {
    const spec = applyOps(base(), [{ op: "removeResource", key: "db" }]);
    expect(spec.resources.db).toBeUndefined();
    // api used db → that dangling `uses` is pruned so the POSTed spec passes validateStackEdges
    expect(spec.resources.api!.uses).toBeUndefined();
  });

  test("removeEdge removes just the one binding", () => {
    const spec = applyOps(base(), [{ op: "removeEdge", from: "api", to: "db", kind: "uses" }]);
    expect(spec.resources.api!.uses).toBeUndefined();
    expect(spec.resources.db).toBeDefined();
  });

  test("preserves unknown/passthrough fields through a round-trip", () => {
    const b: EditorSpec = { name: "s", resources: { a: { type: "app", image: "x", trusted: true } } };
    const spec = applyOps(b, [{ op: "setField", key: "a", field: "image", value: "y" }]);
    expect((spec.resources.a as Record<string, unknown>).trusted).toBe(true);
  });
});

describe("pendingDeleteKeys / buildEditorGraph", () => {
  test("a removed base key stays visible + flagged; its edges are suppressed", () => {
    const ops: EditorOp[] = [{ op: "removeResource", key: "db" }];
    expect(pendingDeleteKeys(base(), ops)).toEqual(["db"]);
    const g = buildEditorGraph(base(), ops);
    const db = g.nodes.find((n) => n.key === "db");
    expect(db?.pendingDelete).toBe(true);
    // no edge references db anymore
    expect(g.edges.some((e) => e.from === "db" || e.to === "db")).toBe(false);
  });
  test("a newly-added node is flagged isNew", () => {
    const g = buildEditorGraph(base(), [{ op: "addResource", key: "cache", resource: newResource("cache") }]);
    expect(g.nodes.find((n) => n.key === "cache")?.isNew).toBe(true);
    expect(g.nodes.find((n) => n.key === "db")?.isNew).toBe(false);
  });
  test("re-adding a deleted key clears its pending-delete flag", () => {
    const ops: EditorOp[] = [
      { op: "removeResource", key: "db" },
      { op: "addResource", key: "db", resource: newResource("database") },
    ];
    expect(pendingDeleteKeys(base(), ops)).toEqual([]);
  });
});

describe("specEdges (mirrors the server graph edge derivation)", () => {
  test("db→app via uses; app→site via env_from with the AS as label", () => {
    const edges = specEdges(base());
    expect(edges).toContainEqual({ from: "db", to: "api", kind: "uses", label: "PG* + CA" });
    expect(edges).toContainEqual({ from: "api", to: "web", kind: "env_from", label: "API_URL" });
  });
});

describe("validateOp", () => {
  test("rejects a duplicate key and an invalid key", () => {
    expect(validateOp(base(), [], { op: "addResource", key: "db", resource: newResource("cache") })).toMatch(/already exists/);
    expect(validateOp(base(), [], { op: "addResource", key: "Bad_Key", resource: newResource("cache") })).toMatch(/invalid key/);
  });

  test("enforces the ≤16 resource cap", () => {
    const ops: EditorOp[] = [];
    for (let i = Object.keys(base().resources).length; i < MAX_RESOURCES; i++) ops.push({ op: "addResource", key: `x${i}`, resource: newResource("cache") });
    // now at the cap — one more is refused
    expect(applyOps(base(), ops)).toBeDefined();
    expect(Object.keys(applyOps(base(), ops).resources).length).toBe(MAX_RESOURCES);
    expect(validateOp(base(), ops, { op: "addResource", key: "over", resource: newResource("cache") })).toMatch(/limited to 16/);
  });

  test("refuses illegal edges with a reason (db→db, app→site, self, wrong-type)", () => {
    const b = base();
    const withCache = applyOps(b, [{ op: "addResource", key: "c2", resource: newResource("cache") }]);
    expect(validateOp(withCache, [], { op: "addEdge", from: "db", to: "c2", kind: "uses" })).toMatch(/cannot connect/);
    expect(validateOp(b, [], { op: "addEdge", from: "api", to: "web", kind: "uses" })).toMatch(/cannot connect/);
    expect(validateOp(b, [], { op: "addEdge", from: "api", to: "api", kind: "uses" })).toMatch(/cannot connect to itself/);
  });

  test("refuses a duplicate edge", () => {
    expect(validateOp(base(), [], { op: "addEdge", from: "api", to: "db", kind: "uses" })).toMatch(/already uses/);
    expect(validateOp(base(), [], { op: "addEdge", from: "web", to: "api", kind: "env_from", as: "X" })).toMatch(/already reads/);
  });

  test("validates the ${as} name on env_from", () => {
    const b = applyOps(base(), [{ op: "removeEdge", from: "web", to: "api", kind: "env_from" }]);
    expect(validateOp(b, [], { op: "addEdge", from: "web", to: "api", kind: "env_from", as: "1bad" })).toMatch(/invalid name/);
    expect(validateOp(b, [], { op: "addEdge", from: "web", to: "api", kind: "env_from", as: "GOOD_1" })).toBeNull();
  });

  test("validates type fields (storage / memory)", () => {
    expect(validateOp(base(), [], { op: "setField", key: "db", field: "storage", value: "nonsense" })).toMatch(/k8s quantity/);
    expect(validateOp(base(), [], { op: "setField", key: "db", field: "storage", value: "512Mi" })).toBeNull();
    // a field not editable on this kind
    expect(validateOp(base(), [], { op: "setField", key: "db", field: "image", value: "x" })).toMatch(/not editable on a database/);
  });

  test("accepts a legal magnetic edge (app→cache)", () => {
    const b = applyOps(base(), [{ op: "addResource", key: "cache", resource: newResource("cache") }]);
    expect(validateOp(b, [], { op: "addEdge", from: "api", to: "cache", kind: "uses" })).toBeNull();
  });
});

describe("K1 auth edges (app→auth uses; auth→database db)", () => {
  const withAuth = () =>
    applyOps(base(), [
      { op: "addResource", key: "auth", resource: newResource("auth") },
      { op: "addEdge", from: "auth", to: "db", kind: "db" }, // auth binds its required database
    ]);

  test("app→auth writes a uses:{auth} slot; specEdges renders AUTH_* and the db edge", () => {
    const spec = applyOps(withAuth(), [{ op: "addEdge", from: "api", to: "auth", kind: "uses" }]);
    expect(spec.resources.api!.uses).toContainEqual({ auth: "auth" });
    expect(spec.resources.auth!.db).toBe("db");
    const edges = specEdges(spec);
    expect(edges).toContainEqual({ from: "auth", to: "api", kind: "uses", label: "AUTH_*" });
    expect(edges).toContainEqual({ from: "db", to: "auth", kind: "db", label: "users DB" });
  });

  test("auth→database db is scalar (re-binding replaces); removeEdge clears it", () => {
    const twoDbs = applyOps(withAuth(), [{ op: "addResource", key: "db2", resource: newResource("database") }]);
    const rebound = applyOps(twoDbs, [{ op: "addEdge", from: "auth", to: "db2", kind: "db" }]);
    expect(rebound.resources.auth!.db).toBe("db2");
    const cleared = applyOps(twoDbs, [{ op: "removeEdge", from: "auth", to: "db", kind: "db" }]);
    expect(cleared.resources.auth!.db).toBeUndefined();
  });

  test("validateOp: auth→app is illegal; a duplicate db re-bind to the same db is refused", () => {
    expect(validateOp(withAuth(), [], { op: "addEdge", from: "auth", to: "api", kind: "db" })).toMatch(/cannot connect/);
    expect(validateOp(withAuth(), [], { op: "addEdge", from: "auth", to: "db", kind: "db" })).toMatch(/already uses database/);
  });

  test("deleting the bound database prunes the auth's db (server then 400s to reconnect)", () => {
    const spec = applyOps(withAuth(), [{ op: "removeResource", key: "db" }]);
    expect(spec.resources.auth!.db).toBeUndefined();
  });
});

describe("H3 app→app edges (service discovery)", () => {
  // a second app the consumer (`api`) can call
  const withPeer = () => applyOps(base(), [{ op: "addResource", key: "backend", resource: { type: "app", image: "b:1" } }]);

  test("app→app writes a uses:{app} slot; specEdges renders <KEY>_URL", () => {
    const spec = applyOps(withPeer(), [{ op: "addEdge", from: "api", to: "backend", kind: "uses" }]);
    expect(spec.resources.api!.uses).toContainEqual({ app: "backend" });
    const edges = specEdges(spec);
    expect(edges).toContainEqual({ from: "backend", to: "api", kind: "uses", label: "BACKEND_URL" });
  });

  test("validateOp accepts app→app uses; refuses self; refuses a mutual cycle", () => {
    expect(validateOp(withPeer(), [], { op: "addEdge", from: "api", to: "backend", kind: "uses" })).toBeNull();
    expect(validateOp(withPeer(), [], { op: "addEdge", from: "api", to: "api", kind: "uses" })).toMatch(/cannot connect to itself/);
    // backend→api already, then api→backend closes the loop → refused as a cycle
    const oneWay = applyOps(withPeer(), [{ op: "addEdge", from: "backend", to: "api", kind: "uses" }]);
    expect(validateOp(oneWay, [], { op: "addEdge", from: "api", to: "backend", kind: "uses" })).toMatch(/cycle/);
  });
});

describe("detectCycle (mirrors plan.ts toposort)", () => {
  test("an acyclic spec has no cycle", () => {
    expect(detectCycle(base())).toBeNull();
  });
  test("a mutual dependency is reported as a cycle", () => {
    // two apps each 'using' the other (a shape the legal-edge table forbids, but detectCycle is the
    // independent safety net the edge validator leans on) → the leftover set is the cycle.
    const cyclic: EditorSpec = { name: "s", resources: { a: { type: "app", uses: [{ database: "b" }] }, b: { type: "app", uses: [{ database: "a" }] } } };
    const cyc = detectCycle(cyclic);
    expect(cyc).not.toBeNull();
    expect(new Set(cyc!)).toEqual(new Set(["a", "b"]));
  });
});

describe("undo/redo history", () => {
  test("commit advances the cursor; undo/redo move it; a new commit truncates the future", () => {
    let s = initEditor(base(), 5);
    expect(isDirty(s)).toBe(false);
    s = commit(s, { op: "addResource", key: "cache", resource: newResource("cache") }).state;
    s = commit(s, { op: "addEdge", from: "api", to: "cache", kind: "uses" }).state;
    expect(currentOps(s).length).toBe(2);
    expect(canUndo(s)).toBe(true);
    s = undo(s);
    expect(currentOps(s).length).toBe(1);
    expect(canRedo(s)).toBe(true);
    s = redo(s);
    expect(currentOps(s).length).toBe(2);
    // undo then a fresh commit drops the redo branch
    s = undo(s);
    s = commit(s, { op: "addResource", key: "bkt", resource: newResource("bucket") }).state;
    expect(canRedo(s)).toBe(false);
    expect(currentOps(s).map((o) => (o.op === "addResource" ? o.key : o.op))).toEqual(["cache", "bkt"]);
  });

  test("a rejected commit leaves the state unchanged and returns the error", () => {
    const s0 = initEditor(base(), 1);
    const { state, error } = commit(s0, { op: "addResource", key: "db", resource: newResource("cache") });
    expect(error).toMatch(/already exists/);
    expect(state).toBe(s0);
  });
});

describe("rebase (409 recovery conflict rules)", () => {
  test("keeps a non-conflicting op", () => {
    const ops: EditorOp[] = [{ op: "addResource", key: "cache", resource: newResource("cache") }];
    const r = rebase(ops, base());
    expect(r.dropped).toEqual([]);
    expect(r.ops).toEqual(ops);
  });

  test("drops addResource when the key now exists upstream", () => {
    const ops: EditorOp[] = [{ op: "addResource", key: "cache", resource: newResource("cache") }];
    const newBase: EditorSpec = { ...base(), resources: { ...base().resources, cache: { type: "cache", memory: "256Mi" } } };
    const r = rebase(ops, newBase);
    expect(r.ops).toEqual([]);
    expect(r.dropped[0]!.reason).toMatch(/created by someone else/);
  });

  test("drops removeResource when the key was already deleted upstream", () => {
    const ops: EditorOp[] = [{ op: "removeResource", key: "db" }];
    const newBase: EditorSpec = { name: "shop", resources: { api: { type: "app", image: "x" }, web: { type: "site" } } };
    const r = rebase(ops, newBase);
    expect(r.ops).toEqual([]);
    expect(r.dropped[0]!.reason).toMatch(/already deleted/);
  });

  test("drops setField when the same field was changed upstream (collision), keeps it otherwise", () => {
    const ops: EditorOp[] = [{ op: "setField", key: "db", field: "storage", value: "2Gi", prev: "1Gi" }];
    // upstream changed storage to 4Gi → collision → dropped
    const collided: EditorSpec = { name: "shop", resources: { ...base().resources, db: { type: "database", storage: "4Gi" } } };
    expect(rebase(ops, collided).ops).toEqual([]);
    expect(rebase(ops, collided).dropped[0]!.reason).toMatch(/changed upstream/);
    // upstream unchanged → kept
    expect(rebase(ops, base()).ops).toEqual(ops);
  });

  test("drops an addEdge whose endpoint vanished upstream", () => {
    const withoutCacheOps: EditorOp[] = [
      { op: "addResource", key: "cache", resource: newResource("cache") },
      { op: "addEdge", from: "api", to: "cache", kind: "uses" },
    ];
    // upstream deleted `api` → both the (still-valid) addResource stays, addEdge drops
    const newBase: EditorSpec = { name: "shop", resources: { db: { type: "database", storage: "1Gi" }, web: { type: "site" } } };
    const r = rebase(withoutCacheOps, newBase);
    expect(r.ops.some((o) => o.op === "addResource")).toBe(true);
    expect(r.ops.some((o) => o.op === "addEdge")).toBe(false);
    expect(r.dropped[0]!.reason).toMatch(/endpoint/);
  });

  test("rebaseState resets base+version and seeds the kept ops as the single history entry", () => {
    let s = initEditor(base(), 3);
    s = commit(s, { op: "addResource", key: "cache", resource: newResource("cache") }).state;
    const { state, dropped } = rebaseState(s, base(), 4);
    expect(dropped).toEqual([]);
    expect(state.baseVersion).toBe(4);
    expect(currentOps(state).length).toBe(1);
    expect(canUndo(state)).toBe(true); // can undo back to the empty base
  });
});

describe("helpers", () => {
  test("suggestKey avoids collisions", () => {
    expect(suggestKey(base(), [], "cache")).toBe("cache");
    expect(suggestKey(base(), [{ op: "addResource", key: "cache", resource: newResource("cache") }], "cache")).toBe("cache2");
    // a base key equal to the type name forces the numeric suffix
    expect(suggestKey({ name: "s", resources: { app: { type: "app" } } }, [], "app")).toBe("app2");
  });
  test("validateKey / validateAsName", () => {
    expect(validateKey("ok-1")).toBeNull();
    expect(validateKey("-nope")).toMatch(/invalid key/);
    expect(validateAsName("API_URL")).toBeNull();
    expect(validateAsName("1x")).toMatch(/invalid name/);
  });
});
