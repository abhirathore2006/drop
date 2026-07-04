// The sidebar's Admin link is gated on me.admin (from /v1/me).
import { setupDom } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "../lib/api.ts";
import { makeQueryClient } from "../lib/query.ts";
import { Sidebar } from "./Sidebar.tsx";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL((input as Request).url, "http://x").pathname;
    if (url === "/v1/orgs") return Promise.resolve(json({ orgs: [{ slug: "me", name: "me@x", kind: "personal", role: "owner" }] }));
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderSidebar(me: Me) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <Sidebar me={me} collapsed={false} onToggleCollapse={() => {}} mobileOpen={false} onCloseMobile={() => {}} onOpenPalette={() => {}} />
    </QueryClientProvider>,
  );
}

describe("Sidebar", () => {
  test("hides the admin link for non-admins, shows the rest", () => {
    const r = renderSidebar({ email: "u@x", admin: false });
    expect(r.getByText("workloads")).toBeTruthy();
    expect(r.getByText("stacks")).toBeTruthy();
    expect(r.getByText("settings")).toBeTruthy();
    expect(r.queryByText("admin")).toBeNull();
  });

  test("shows the admin link for admins", () => {
    const r = renderSidebar({ email: "a@x", admin: true });
    expect(r.getByText("admin")).toBeTruthy();
  });
});
