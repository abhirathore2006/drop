// Frame smoke: the shell composes (sidebar + slim header + routed page), and ⌘K/Ctrl+K
// opens the command palette over the cached lists.
import { changeValue, setupDom } from "./test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { makeQueryClient } from "./lib/query.ts";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const routes: Record<string, unknown> = {
  "/v1/me": { email: "alice@example.com", admin: false },
  "/v1/orgs": { orgs: [{ slug: "me", name: "alice@example.com", kind: "personal", role: "owner" }] },
  "/v1/sites": { sites: [{ name: "web", type: "site", owner: "alice@example.com", org: null, visibility: "public", url: "https://web.x", current: null }] },
  "/v1/stacks": { stacks: [] },
  "/version": { version: "2.0.0+test" },
};

let realFetch: typeof fetch;
beforeEach(() => {
  // happy-dom defaults to about:blank; give the router a real "/" so wouter routes normally.
  (window as unknown as { happyDOM?: { setURL?: (u: string) => void } }).happyDOM?.setURL?.("http://localhost/");
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL((input as Request).url, "http://x").pathname;
    return Promise.resolve(json(routes[url] ?? {}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderApp() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("App frame", () => {
  test("renders the sidebar frame, user menu, and the workloads page", async () => {
    const r = renderApp();
    // sidebar nav present
    expect(await r.findByText("workloads")).toBeTruthy();
    expect(r.getByText("stacks")).toBeTruthy();
    // routed page rendered the workload
    expect(await r.findByText("web")).toBeTruthy();
    // header identity (also appears as the card owner, hence getAllByText)
    expect(r.getAllByText("alice@example.com").length).toBeGreaterThan(0);
  });

  test("Ctrl+K opens the command palette and it filters the cached workloads", async () => {
    const r = renderApp();
    await r.findByText("web"); // let the lists cache

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const input = await r.findByLabelText("command palette filter");
    changeValue(input, "web");
    // the cached "web" site surfaces as a palette result (inside the listbox)
    expect(r.getByRole("listbox").textContent).toContain("web");
  });
});
