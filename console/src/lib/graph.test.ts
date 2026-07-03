// Pure canvas data-transform tests (no DOM): the status-dot bucket mapping, the layered layout, and
// the pending-overlay index.
import { describe, expect, test } from "bun:test";
import type { GraphEdge, GraphNode, GraphPlanStep } from "./api.ts";
import { COL_W, hasPending, layoutNodes, nodeDotClass, pendingByKey } from "./graph.ts";

describe("nodeDotClass (status-dot color mapping)", () => {
  test("green running / gray asleep|stopped / amber progressing / red error|degraded", () => {
    expect(nodeDotClass("running")).toBe("sdot sdot-green");
    expect(nodeDotClass("asleep")).toBe("sdot sdot-gray");
    expect(nodeDotClass("stopped")).toBe("sdot sdot-gray");
    expect(nodeDotClass("progressing")).toBe("sdot sdot-amber");
    expect(nodeDotClass("error")).toBe("sdot sdot-red");
    expect(nodeDotClass("degraded")).toBe("sdot sdot-red");
    expect(nodeDotClass("anything-else")).toBe("sdot sdot-gray"); // safe default
  });
});

const node = (key: string, type: GraphNode["type"]): GraphNode => ({
  key,
  siteName: `shop-${key}`,
  type,
  url: `https://shop-${key}.x`,
  currentVersion: null,
  exists: true,
  status: { status: "running", reason: "ok" },
});

describe("layoutNodes (layered left-to-right by topological depth)", () => {
  test("databases at column 0, apps at 1, sites at 2", () => {
    const nodes = [node("db", "database"), node("api", "app"), node("web", "site")];
    const edges: GraphEdge[] = [
      { from: "db", to: "api", kind: "uses", label: "PG* via shop-db-app" },
      { from: "api", to: "web", kind: "env_from", label: "URL at publish" },
    ];
    const pos = layoutNodes(nodes, edges);
    expect(pos.db!.x).toBe(0);
    expect(pos.api!.x).toBe(COL_W);
    expect(pos.web!.x).toBe(2 * COL_W);
  });

  test("nodes in the same column stack vertically without overlap", () => {
    const nodes = [node("db", "database"), node("cache", "database")]; // both depth 0
    const pos = layoutNodes(nodes, []);
    expect(pos.db!.x).toBe(0);
    expect(pos.cache!.x).toBe(0);
    expect(pos.db!.y).not.toBe(pos.cache!.y);
  });

  test("terminates on a (shouldn't-happen) cycle instead of looping", () => {
    const nodes = [node("a", "app"), node("b", "app")];
    const edges: GraphEdge[] = [
      { from: "a", to: "b", kind: "uses", label: "" },
      { from: "b", to: "a", kind: "uses", label: "" },
    ];
    expect(() => layoutNodes(nodes, edges)).not.toThrow();
  });
});

describe("pendingByKey / hasPending (overlay index)", () => {
  const plan: GraphPlanStep[] = [
    { action: "create", key: "db", kind: "database", siteName: "shop-db", reason: "not present" },
    { action: "noop", key: "api", kind: "app", siteName: "shop-api", reason: "unchanged" },
  ];
  test("indexes non-noop steps by key; noop is ignored", () => {
    expect(pendingByKey(plan)).toEqual({ db: "create" });
    expect(hasPending(plan)).toBe(true);
  });
  test("an all-noop (or absent) plan is not pending", () => {
    expect(hasPending([{ action: "noop", key: "x", kind: "app", siteName: "x", reason: "" }])).toBe(false);
    expect(hasPending(undefined)).toBe(false);
    expect(pendingByKey(undefined)).toEqual({});
  });
});
