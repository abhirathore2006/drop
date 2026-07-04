// Page-level smoke: the list page renders grouped workloads from a mocked fetch.
import { setupDom } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast.tsx";
import { makeQueryClient } from "../lib/query.ts";
import { WorkloadsPage } from "./WorkloadsPage.tsx";

setupDom();

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const SITES = {
  sites: [
    { name: "my-app", type: "app", owner: "alice@example.com", org: { slug: "acme", name: "Acme", kind: "team" }, visibility: "public", url: "https://my-app.x", current: null },
    { name: "my-db", type: "database", owner: "alice@example.com", org: { slug: "acme", name: "Acme", kind: "team" }, visibility: "public", url: "", current: null },
    { name: "my-site", type: "site", owner: "alice@example.com", org: null, visibility: "public", url: "https://my-site.x", current: "v_1700000000_abc123" },
  ],
};
const USAGE = {
  org: { slug: "acme", name: "Acme", kind: "team" },
  workloads: { site: 0, app: 1, database: 1, bucket: 2, cache: 1, auth: 0, total: 5 },
  cap: 5,
  quota: null,
};

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url, "http://x").pathname;
    if (url.startsWith("/v1/orgs/") && url.endsWith("/usage")) return Promise.resolve(json(USAGE));
    if (url.startsWith("/v1/sites")) return Promise.resolve(json(SITES));
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("WorkloadsPage", () => {
  test("renders workloads grouped by type with usage cards", async () => {
    const r = render(
      <QueryClientProvider client={makeQueryClient()}>
        <ToastProvider>
          <WorkloadsPage />
        </ToastProvider>
      </QueryClientProvider>,
    );

    // grouped sections appear with counts
    expect(await r.findByText("Apps")).toBeTruthy();
    expect(r.getByText("Databases")).toBeTruthy();
    expect(r.getByText("Sites")).toBeTruthy();

    // each workload card is present, linking to its detail route
    const appCard = (await r.findByText("my-app")).closest("a");
    expect(appCard?.getAttribute("href")).toBe("/app/my-app");
    expect(r.getByText("my-db").closest("a")?.getAttribute("href")).toBe("/database/my-db");
    expect(r.getByText("my-site").closest("a")?.getAttribute("href")).toBe("/site/my-site");

    // version chip shortened, usage summary rendered from the org usage endpoint
    expect(r.getByText("#abc123")).toBeTruthy();
    expect(await r.findByText("Usage")).toBeTruthy();
    expect(r.getByText(/1 apps · 1 dbs · 1 caches · 0 auth · 2 buckets · 0 sites/)).toBeTruthy();
  });

  test("renders first-run onboarding when there are no workloads", async () => {
    globalThis.fetch = (() => Promise.resolve(json({ sites: [] }))) as unknown as typeof fetch;
    const r = render(
      <QueryClientProvider client={makeQueryClient()}>
        <ToastProvider>
          <WorkloadsPage />
        </ToastProvider>
      </QueryClientProvider>,
    );
    // both first-win paths are offered: the CLI install one-liner and the drop zone
    expect(await r.findByText("install the CLI")).toBeTruthy();
    expect(r.getByText("or drag a folder")).toBeTruthy();
    expect(r.getByText(/curl -fsSL .*\/install\.sh \| sh/)).toBeTruthy();
  });
});
