// Smoke (G3): the Activity org-events feed, the sidebar unread badge, and the Settings › Webhooks tab.
// Fetch is mocked; these assert the wiring (right calls, gating, severity rendering), not styling.
import { setupDom, changeValue } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast.tsx";
import { makeQueryClient } from "../lib/query.ts";
import { ActivityPage } from "./ActivityPage.tsx";
import { Webhooks } from "./SettingsPage.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import type { Me } from "../lib/api.ts";
import type { OrgSummary } from "../lib/api-extra.ts";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const owner: OrgSummary = { slug: "acme", name: "Acme", kind: "team", role: "owner" };
const viewer: OrgSummary = { slug: "acme", name: "Acme", kind: "team", role: "viewer" };
const PERSONAL = { slug: "me", name: "me@x.com", kind: "personal", role: "owner" };

const EVENT = {
  id: "42",
  orgId: "org_1",
  siteName: "api",
  kind: "crashloop",
  severity: "error" as const,
  title: "crash-loop: api",
  detail: { restarts: 3 },
  createdAt: "2026-07-04T00:00:00.000Z",
  resolvedAt: null,
};

let realFetch: typeof fetch;
let calls: { method: string; url: string; body: unknown }[];
let webhookState: { webhook: unknown } = { webhook: null };
beforeEach(() => {
  calls = [];
  webhookState = { webhook: null };
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url, "http://x").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/v1/orgs" && method === "GET") return Promise.resolve(json({ orgs: [PERSONAL] }));
    if (url === "/v1/orgs/me/events" && method === "GET") return Promise.resolve(json({ events: [EVENT] }));
    if (url === "/v1/admin/audit") return Promise.resolve(json({ entries: [] }));
    if (url === "/v1/orgs/acme/webhook" && method === "GET") return Promise.resolve(json(webhookState));
    if (url === "/v1/orgs/acme/webhook" && method === "POST") {
      webhookState = { webhook: { url: (init!.body ? JSON.parse(String(init!.body)) : {}).url, hasSecret: false, updatedBy: "alice@example.com", updatedAt: "2026-07-04T00:00:00.000Z" } };
      return Promise.resolve(json({ webhook: webhookState.webhook }));
    }
    if (url === "/v1/orgs/acme/webhook" && method === "DELETE") return Promise.resolve(json({ removed: true }));
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

describe("Activity › org events feed", () => {
  test("a non-admin sees the org events feed (severity pill + title), no audit trail", async () => {
    const me: Me = { email: "me@x.com", admin: false };
    const r = render(wrap(<ActivityPage me={me} />));
    expect(await r.findByText("crash-loop: api")).toBeTruthy();
    expect(r.getByText("error")).toBeTruthy(); // severity pill
    expect(r.getByText("crashloop")).toBeTruthy(); // kind
    expect(r.queryByText("Audit trail")).toBeNull(); // admin-only section absent
  });
});

describe("Sidebar unread badge (G3)", () => {
  const props = { collapsed: false, onToggleCollapse: () => {}, mobileOpen: false, onCloseMobile: () => {}, onOpenPalette: () => {} };
  test("shows the unresolved count when > 0", () => {
    const r = render(wrap(<Sidebar me={{ email: "a@x.com", admin: false, unresolvedEvents: 3 }} {...props} />));
    expect(r.getByLabelText("3 unresolved events")).toBeTruthy();
  });
  test("no badge when zero", () => {
    const r = render(wrap(<Sidebar me={{ email: "a@x.com", admin: false, unresolvedEvents: 0 }} {...props} />));
    expect(r.queryByLabelText(/unresolved events/)).toBeNull();
  });
});

describe("Settings › Webhooks", () => {
  test("a non-owner/admin is gated out", () => {
    const r = render(wrap(<Webhooks org={viewer} />));
    expect(r.getByText(/Owner\/admin only/)).toBeTruthy();
  });

  test("owner sets a webhook (POST) and can remove it (DELETE via confirm)", async () => {
    const r = render(wrap(<Webhooks org={owner} />));
    // initially none
    expect(await r.findByText(/No webhook set/)).toBeTruthy();
    changeValue(r.getByLabelText("webhook url"), "https://hooks.slack.com/services/T/B/X");
    fireEvent.click(r.getByRole("button", { name: /save webhook/ }));
    await new Promise((res) => setTimeout(res, 0));
    const posted = calls.find((c) => c.method === "POST" && c.url === "/v1/orgs/acme/webhook");
    expect(posted?.body).toMatchObject({ url: "https://hooks.slack.com/services/T/B/X" });

    // now it shows as active + a remove button; confirm → DELETE
    expect(await r.findByText("https://hooks.slack.com/services/T/B/X")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "remove" }));
    expect(await r.findByText(/Remove the events webhook/)).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "remove webhook" }));
    await new Promise((res) => setTimeout(res, 0));
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/v1/orgs/acme/webhook")).toBe(true);
  });
});
