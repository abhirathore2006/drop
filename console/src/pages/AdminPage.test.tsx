// Smoke: the Admin › Quotas editor (M2 / item 10). Pick an org, see its overrides + the instance
// default hints, edit a value, and save → a PUT with the changed key. Fetch is mocked.
import { setupDom, changeValue } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast.tsx";
import { makeQueryClient } from "../lib/query.ts";
import { QuotaEditor } from "./AdminPage.tsx";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const QUOTAS = {
  org: { slug: "acme", name: "Acme" },
  keys: ["max_workloads", "max_db_storage", "storage_budget_bytes"],
  overrides: [{ key: "max_workloads", value: "10", updatedBy: "root@x", updatedAt: "2026-06-01T00:00:00.000Z" }],
  effective: { max_workloads: 10, max_db_storage: "1Gi", storage_budget_bytes: null },
};

let realFetch: typeof fetch;
let calls: { method: string; url: string; body: any }[];
beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url, "http://x").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/v1/admin/orgs" && method === "GET") return Promise.resolve(json({ orgs: [{ slug: "acme", name: "Acme", kind: "team", owner: "alice@example.com" }] }));
    if (url === "/v1/admin/orgs/acme/quotas" && method === "GET") return Promise.resolve(json(QUOTAS));
    if (url === "/v1/admin/orgs/acme/quotas" && method === "PUT") return Promise.resolve(json({ org: "acme", set: { max_workloads: "25" } }));
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

describe("Admin › Quotas", () => {
  test("pick an org → shows the current override + default hints; editing + saving PUTs the changed key", async () => {
    const r = render(wrap(<QuotaEditor />));
    // wait for the org list to load so the "acme" option exists before selecting it
    await r.findByText(/Acme/);
    changeValue(r.getByLabelText("org"), "acme");
    // the editor loads: the storage_budget_bytes row is unset → its default hint reads "no budget"
    expect(await r.findByText(/no budget/)).toBeTruthy();
    // the max_workloads input is prefilled from the override
    const mw = r.getByLabelText("max_workloads") as HTMLInputElement;
    expect(mw.value).toBe("10");
    // edit it and save
    changeValue(mw, "25");
    fireEvent.click(r.getByRole("button", { name: "save" }));
    await new Promise((res) => setTimeout(res, 0));
    const put = calls.find((c) => c.method === "PUT" && c.url === "/v1/admin/orgs/acme/quotas");
    expect(put).toBeTruthy();
    expect(put?.body).toMatchObject({ quotas: { max_workloads: "25" } });
  });
});
