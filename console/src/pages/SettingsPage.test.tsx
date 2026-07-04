// Smoke: the Settings › Tokens tab (J1). Owner sees the scope builder + token list; create reveals the
// secret once (RevealOnce); revoke goes through the ConfirmDialog and issues a DELETE. Fetch is mocked.
import { setupDom, changeValue } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast.tsx";
import { makeQueryClient } from "../lib/query.ts";
import { Members, Tokens } from "./SettingsPage.tsx";
import type { OrgSummary } from "../lib/api-extra.ts";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const owner: OrgSummary = { slug: "acme", name: "Acme", kind: "team", role: "owner" };
const viewer: OrgSummary = { slug: "acme", name: "Acme", kind: "team", role: "viewer" };
const EXISTING = {
  id: "st_old",
  name: "old-ci",
  scopes: ["deploy:myapp"],
  expiresAt: null,
  createdBy: "alice@example.com",
  createdAt: "2026-06-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

let realFetch: typeof fetch;
let calls: { method: string; url: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url, "http://x").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/tokens") && method === "GET") return Promise.resolve(json({ tokens: [EXISTING] }));
    if (url.endsWith("/tokens") && method === "POST") {
      const body = init?.body ? (JSON.parse(String(init.body)) as { name: string; scopes: string[] }) : { name: "", scopes: [] };
      return Promise.resolve(json({ token: "drop_st_revealedsecret", id: "st_new", name: body.name, scopes: body.scopes, expiresAt: null, createdBy: "alice@example.com", createdAt: "2026-07-04T00:00:00.000Z" }));
    }
    if (url === "/v1/orgs/acme" && method === "GET")
      return Promise.resolve(json({ slug: "acme", name: "Acme", kind: "team", members: [{ email: "alice@example.com", role: "owner" }, { email: "bob@example.com", role: "member" }] }));
    if (url.includes("/members/") && method === "PATCH") {
      const body = init?.body ? (JSON.parse(String(init.body)) as { role: string }) : { role: "" };
      return Promise.resolve(json({ slug: "acme", email: "bob@example.com", role: body.role }));
    }
    if (method === "DELETE") return Promise.resolve(json({ revoked: "st_old", name: "old-ci" }));
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

describe("Settings › Tokens", () => {
  test("a non-owner/admin is gated out", () => {
    const r = render(wrap(<Tokens org={viewer} />));
    expect(r.getByText(/Owner\/admin only/)).toBeTruthy();
    expect(r.queryByRole("button", { name: "create token" })).toBeNull();
  });

  test("owner: lists existing tokens (with active state + revoke control)", async () => {
    const r = render(wrap(<Tokens org={owner} />));
    expect(await r.findByText("old-ci")).toBeTruthy();
    expect(r.getByText("deploy:myapp")).toBeTruthy();
    expect(r.getByText("active")).toBeTruthy();
    expect(r.getByRole("button", { name: "revoke" })).toBeTruthy();
  });

  test("create reveals the secret ONCE, then revoke confirms + issues a DELETE", async () => {
    const r = render(wrap(<Tokens org={owner} />));
    await r.findByText("old-ci"); // list loaded

    // create: fill the name, submit, and see the one-time secret
    changeValue(r.getByPlaceholderText("name (e.g. ci-deploy)"), "ci-deploy");
    fireEvent.click(r.getByRole("button", { name: "create token" }));
    expect(await r.findByText("drop_st_revealedsecret")).toBeTruthy();
    expect(r.getByRole("button", { name: "I saved it" })).toBeTruthy(); // RevealOnce dismissal
    const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/tokens"));
    expect(created?.body).toMatchObject({ name: "ci-deploy" });

    // revoke: open the confirm dialog, confirm, and assert the DELETE fired
    fireEvent.click(r.getByRole("button", { name: "revoke" }));
    expect(await r.findByText(/Revoke old-ci/)).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "revoke token" }));
    await new Promise((res) => setTimeout(res, 0));
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/v1/orgs/acme/tokens/st_old")).toBe(true);
  });
});

describe("Settings › Members (M2)", () => {
  test("owner sees a role select for a non-owner member; changing it issues a PATCH", async () => {
    const r = render(wrap(<Members org={owner} />));
    expect(await r.findByText("bob@example.com")).toBeTruthy();
    // the founding owner (alice) is immutable — a role pill, not a select
    expect(r.queryByLabelText("role for alice@example.com")).toBeNull();
    const sel = r.getByLabelText("role for bob@example.com") as HTMLSelectElement;
    changeValue(sel, "admin");
    await new Promise((res) => setTimeout(res, 0));
    const patched = calls.find((c) => c.method === "PATCH" && c.url === "/v1/orgs/acme/members/bob%40example.com");
    expect(patched).toBeTruthy();
    expect(patched?.body).toMatchObject({ role: "admin" });
  });

  test("a viewer can't manage members (no add form, no role selects)", async () => {
    const r = render(wrap(<Members org={viewer} />));
    expect(await r.findByText("bob@example.com")).toBeTruthy();
    expect(r.queryByLabelText("role for bob@example.com")).toBeNull();
    expect(r.queryByLabelText("new member email")).toBeNull();
  });
});
