// Page-level smoke for the read-only stack canvas. The heavy @xyflow canvas is code-split behind
// React.lazy and does not render meaningfully under happy-dom (no layout engine), so — per the C1
// brief — this asserts on the always-rendered surfaces (header + resource legend, which carry the node
// NAMES and detail links) and on the pending-changes overlay. The canvas's own logic is covered by the
// isolated data-transform tests (lib/graph.test.ts) and node-body tests (components/StackNodeBody.test.tsx).
import { setupDom } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { makeQueryClient } from "../lib/query.ts";
import { StackPage } from "./StackPage.tsx";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const GRAPH = {
  name: "shop",
  org: { slug: "acme", name: "Acme", kind: "team" },
  specVersion: 3,
  nodes: [
    { key: "db", siteName: "shop-db", type: "database", url: "https://shop-db.x", currentVersion: null, exists: true, status: { status: "running", reason: "healthy" } },
    { key: "api", siteName: "shop-api", type: "app", url: "https://shop-api.x", currentVersion: "v_1700000000_abc123", exists: true, status: { status: "running", reason: "1/1 ready" } },
    { key: "web", siteName: "shop-web", type: "site", url: "https://shop-web.x", currentVersion: "v_1700000001_def456", exists: true, status: { status: "running", reason: "serving" } },
  ],
  edges: [
    { from: "db", to: "api", kind: "uses", label: "PG* via shop-db-app" },
    { from: "api", to: "web", kind: "env_from", label: "URL at publish" },
  ],
  plan: [] as unknown[],
};

let realFetch: typeof fetch;
let graph: typeof GRAPH;
beforeEach(() => {
  graph = structuredClone(GRAPH);
  // ReactFlow (if the lazy chunk resolves) reaches for ResizeObserver; stub it so it never throws loudly.
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url, "http://x").pathname;
    if (url.includes("/graph")) return Promise.resolve(json(graph));
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const renderPage = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <StackPage name="shop" />
    </QueryClientProvider>,
  );

describe("StackPage", () => {
  test("renders the stack header and a legend of all three node names, linking to detail pages", async () => {
    const r = renderPage();
    // header
    expect(await r.findByText("shop")).toBeTruthy();
    // Every node name renders in the legend, each linking to its per-type detail page. Scope to the
    // legend so a (lazily-mounted) canvas rendering the same names can't cause a multiple-match.
    const legend = within(r.container.querySelector(".stack-legend") as HTMLElement);
    expect(legend.getByText("db").closest("a")?.getAttribute("href")).toBe("/database/shop-db");
    expect(legend.getByText("api").closest("a")?.getAttribute("href")).toBe("/app/shop-api");
    expect(legend.getByText("web").closest("a")?.getAttribute("href")).toBe("/site/shop-web");
    // no pending overlay for an all-clean graph
    expect(r.container.querySelector(".pending-drawer")).toBeNull();
    expect(r.container.querySelector(".pending-pill")).toBeNull();
  });

  test("surfaces a pending-changes overlay when the plan has non-noop steps", async () => {
    graph.plan = [{ action: "create", key: "db", kind: "database", siteName: "shop-db", reason: "not present — will create" }];
    graph.nodes[0]!.exists = false;
    const r = renderPage();
    // header pill + drawer both appear
    expect(await r.findByText("shop")).toBeTruthy();
    expect(r.container.querySelector(".pending-pill")).toBeTruthy();
    const drawer = r.container.querySelector(".pending-drawer") as HTMLElement;
    expect(drawer).toBeTruthy();
    expect(within(drawer).getByText(/not present — will create/)).toBeTruthy();
  });
});
