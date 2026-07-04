// Page-level smoke for the read-only stack canvas. The heavy @xyflow canvas is code-split behind
// React.lazy and does not render meaningfully under happy-dom (no layout engine), so — per the C1
// brief — this asserts on the always-rendered surfaces (header + resource legend, which carry the node
// NAMES and detail links) and on the pending-changes overlay. The canvas's own logic is covered by the
// isolated data-transform tests (lib/graph.test.ts) and node-body tests (components/StackNodeBody.test.tsx).
import { setupDom, changeValue } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast.tsx";
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

// GET /v1/stacks/shop (the editable spec + version) and the up-dry-run plan, for the C2 edit-mode smoke.
const DETAIL = {
  name: "shop",
  org: { slug: "acme", name: "Acme", kind: "team" },
  specVersion: 3,
  fromTemplate: null,
  fromTemplateVersion: null,
  spec: { name: "shop", resources: { api: { type: "app", image: "ghcr.io/x/api:1" } } },
  resources: [{ key: "api", type: "app", siteName: "shop-api", exists: true, url: "https://shop-api.x", runtimeState: "running" }],
};
const DRY_RUN_PLAN = {
  stack: "shop",
  org: "acme",
  specVersion: 3,
  dryRun: true,
  needs: [],
  plan: [{ action: "create", key: "database", kind: "database", siteName: "shop-database", reason: "not present — will create" }],
};

// (E3) The environments list backing the env switcher: one named env ("staging") + the implicit default.
const ENVIRONMENTS = { stack: "shop", default: { name: "default", resources: 3 }, environments: [{ name: "staging", variables: { REGION: "eu" }, resources: 3, createdBy: "a@x", createdAt: "2026-07-01T00:00:00Z" }] };

let realFetch: typeof fetch;
let graph: typeof GRAPH;
let fetchCalls: { method: string; url: string; body?: string }[];
beforeEach(() => {
  graph = structuredClone(GRAPH);
  fetchCalls = [];
  // ReactFlow (if the lazy chunk resolves) reaches for ResizeObserver; stub it so it never throws loudly.
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const full = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : new URL(input.url, "http://x").pathname;
    fetchCalls.push({ method: init?.method ?? "GET", url: full, body: init?.body as string | undefined });
    const url = full.split("?")[0]!; // strip the query so /…/up?dry_run=1 matches by path
    if (url.endsWith("/environments")) return Promise.resolve(json(ENVIRONMENTS)); // (E3) env list
    if (url.includes("/graph")) return Promise.resolve(json(graph));
    if (url.endsWith("/up")) return Promise.resolve(json(DRY_RUN_PLAN)); // dry-run + execute both hit /up
    if (url === "/v1/stacks/shop") return Promise.resolve(json(DETAIL));
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const renderPage = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <ToastProvider>
        <StackPage name="shop" />
      </ToastProvider>
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

// (E3) env-switcher smoke: the switcher lists "default" + named envs; switching refetches the graph with
// ?env=; the "+ env" button opens the create-env form and submitting POSTs to /environments.
describe("StackPage env switcher (E3)", () => {
  test("lists default + named envs; switching refetches the graph with ?env=", async () => {
    const r = renderPage();
    await r.findByText("shop"); // page loaded
    const select = (await r.findByTestId("env-select")) as HTMLSelectElement;
    // options: default + the mocked "staging"
    const options = within(select).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["default", "staging"]);
    // switching to staging refetches the graph scoped to that env
    fireEvent.change(select, { target: { value: "staging" } });
    await new Promise((res) => setTimeout(res, 0));
    expect(fetchCalls.some((c) => c.url.includes("/graph") && c.url.includes("env=staging"))).toBe(true);
  });

  test("the + env button opens the create form and submitting POSTs the new environment", async () => {
    const r = renderPage();
    await r.findByText("shop");
    fireEvent.click(await r.findByTestId("env-new-btn"));
    changeValue(await r.findByTestId("env-name-input"), "prod");
    changeValue(r.getByTestId("env-vars-input"), "REGION=eu\nDB_SIZE=512Mi");
    fireEvent.click(r.getByTestId("env-create-submit"));
    await waitFor(() => expect(fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/environments"))).toBeTruthy());
    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/environments"))!;
    const body = JSON.parse(post.body!);
    expect(body.env).toBe("prod");
    expect(body.variables).toEqual({ REGION: "eu", DB_SIZE: "512Mi" });
  });
});

// C2 edit-mode smoke: the palette + apply flow are @xyflow-FREE (the editable canvas is behind Suspense
// and doesn't render meaningfully under happy-dom), so this drives the always-rendered shell: enter edit
// mode → add a database via the palette → Apply → the dry-run plan modal shows the create step.
describe("StackPage edit mode (C2)", () => {
  test("enter edit → add a db node → Apply shows the dry-run plan with a create step", async () => {
    const r = renderPage();
    // enter edit mode
    fireEvent.click(await r.findByRole("button", { name: "Edit" }));
    // palette appears once the spec has loaded (the lazy @xyflow canvas loads in parallel — give it room)
    const addDb = await r.findByTestId("palette-database", {}, { timeout: 4000 });
    fireEvent.click(addDb);
    // now dirty → Apply enabled; click it to run the (mocked) dry-run
    const apply = r.getByRole("button", { name: "Apply" });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(apply);
    // plan modal renders the create step for the new database
    const planTable = await r.findByTestId("plan-table", {}, { timeout: 4000 });
    expect(within(planTable).getByText("create")).toBeTruthy();
    expect(within(planTable).getByText(/not present — will create/)).toBeTruthy();
    // the new resource key ("database") shows in the plan (appears in both the kind + key cells)
    expect(within(planTable).getAllByText("database").length).toBeGreaterThan(0);
  });
});

// D2 upstream-diff smoke: a mocked /outdated with an upstream change (one conflict + one clean upgrade +
// one added resource) → the banner shows → the review view renders per-resource diff badges → the Upgrade
// button is gated until the conflict is resolved → resolving + Upgrade opens the dry-run plan modal.
const OUTDATED = {
  upToDate: false,
  templateDerived: true,
  template: "kit",
  fromVersion: "1",
  latestVersion: "2",
  diff: {
    upstreamChanged: true,
    hasLocalDrift: true,
    conflicts: ["db"],
    resources: [
      { key: "db", class: "conflict", conflict: true, badge: "conflict", fields: [{ field: "storage", class: "conflict", pinned: "1Gi", latest: "512Mi", current: "256Mi" }], inPinned: true, inLatest: true, inCurrent: true },
      { key: "api", class: "upstream-only", conflict: false, badge: "changed", fields: [{ field: "image", class: "upstream-only", pinned: "web:1", latest: "web:2" }], inPinned: true, inLatest: true, inCurrent: true },
      { key: "cache", class: "added-upstream", conflict: false, badge: "added", fields: [], inPinned: false, inLatest: true, inCurrent: false },
    ],
  },
  current: { name: "shop", resources: { db: { type: "database", storage: "256Mi" }, api: { type: "app", image: "web:1" } } },
  latest: { name: "shop", resources: { db: { type: "database", storage: "512Mi" }, api: { type: "app", image: "web:2" }, cache: { type: "cache", memory: "256Mi" } } },
};
const UPGRADE_PLAN = {
  dryRun: true,
  template: "kit",
  fromVersion: "1",
  toVersion: "2",
  autoApplied: ["api", "cache"],
  plan: [
    { action: "update", key: "api", kind: "app", siteName: "shop-api", reason: "image changed upstream" },
    { action: "create", key: "cache", kind: "cache", siteName: "shop-cache", reason: "added upstream" },
  ],
};

describe("StackPage update banner + diff view (D2)", () => {
  beforeEach(() => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const path = raw.split("?")[0]!;
      if (path.includes("/outdated")) return Promise.resolve(json(OUTDATED));
      if (path.endsWith("/upgrade")) return Promise.resolve(json(raw.includes("dry_run") ? UPGRADE_PLAN : { ...UPGRADE_PLAN, dryRun: false, specVersion: 2, stack: "shop" }));
      if (path.includes("/graph")) return Promise.resolve(json(graph));
      return Promise.resolve(json({}));
    }) as unknown as typeof fetch;
  });

  test("banner shows when an update is available and flags the conflict count", async () => {
    const r = renderPage();
    const banner = await r.findByTestId("update-banner");
    expect(within(banner).getByText("kit")).toBeTruthy();
    expect(within(banner).getByText(/1 conflict/)).toBeTruthy();
  });

  test("review view renders per-resource diff badges; Upgrade is gated until the conflict is resolved", async () => {
    const r = renderPage();
    fireEvent.click(await r.findByRole("button", { name: "Review update" }));

    // every changed resource shows its badge in the always-rendered diff legend
    expect((await r.findByTestId("diff-badge-db")).textContent).toBe("conflict");
    expect(r.getByTestId("diff-badge-api").textContent).toBe("changed");
    expect(r.getByTestId("diff-badge-cache").textContent).toBe("added");

    // the conflict is unresolved → Upgrade disabled
    const upgradeBtn = r.getByTestId("upgrade-btn") as HTMLButtonElement;
    expect(upgradeBtn.disabled).toBe(true);

    // resolve db=take-upstream → Upgrade enabled
    fireEvent.click(r.getByTestId("take-upstream-db"));
    expect((r.getByTestId("upgrade-btn") as HTMLButtonElement).disabled).toBe(false);

    // Upgrade → dry-run plan modal shows the update + create steps
    fireEvent.click(r.getByTestId("upgrade-btn"));
    const planTable = await r.findByTestId("upgrade-plan-table", {}, { timeout: 4000 });
    expect(within(planTable).getByText("update")).toBeTruthy();
    expect(within(planTable).getByText("create")).toBeTruthy();
    expect(r.getByTestId("confirm-upgrade")).toBeTruthy();
  });
});

// M4 composition smoke: the flagship StackPage composes the canvas + per-resource metric CHIPS + the E3
// env-switcher SLOT. The chips come from a per-node 1h metrics summary (no batch endpoint exists); this
// mocks graph + metrics and asserts a chip renders in the legend and the E3 slot is present.
describe("StackPage composition (M4)", () => {
  beforeEach(() => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const path = raw.split("?")[0]!;
      if (path.includes("/graph")) return Promise.resolve(json(graph));
      if (path.endsWith("/metrics")) {
        // shop-api gets real traffic; the others none — the chip only shows where there is signal.
        const totals = path.includes("shop-api") ? { requests: 1234, errors: 5, bytesIn: 0, bytesOut: 0, p50: 4, p95: 9 } : { requests: 0, errors: 0, bytesIn: 0, bytesOut: 0, p50: 0, p95: 0 };
        return Promise.resolve(json({ range: "1h", series: [], totals }));
      }
      return Promise.resolve(json({}));
    }) as unknown as typeof fetch;
  });

  test("renders a per-resource metric chip and the E3 env-switcher slot", async () => {
    const r = renderPage();
    await r.findByText("shop"); // header rendered
    // the E3 slot placeholder is present (a later slice mounts the picker here)
    expect(r.getByTestId("env-switcher-slot")).toBeTruthy();
    // the api node's 1h request count renders as a chip in the legend (1234 → "1.2k")
    const legend = within(r.container.querySelector(".stack-legend") as HTMLElement);
    expect(await legend.findByText("1.2k")).toBeTruthy();
    // and its error count
    expect(legend.getByText(/5/)).toBeTruthy();
  });
});
