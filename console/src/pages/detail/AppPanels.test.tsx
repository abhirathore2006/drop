// (L4) Smoke: the app runtime-config table renders NON-SECRET values in plaintext and drives inline
// add / edit / remove through the config API; the whole surface is gated on `configure`.
import { setupDom, changeValue } from "../../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast.tsx";
import { makeQueryClient } from "../../lib/query.ts";
import { AppPanels, ConfigPanel } from "./AppPanels.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const detail = (caps: string[]): Detail =>
  ({
    name: "billing",
    type: "app",
    owner: "alice@example.com",
    collaborators: [],
    members: [{ email: "alice@example.com", role: "owner" }],
    visibility: "private",
    current: "v1",
    url: "https://billing.x",
    versions: [],
    capabilities: caps,
    app: { image: "img:1", scale: { min: 1, max: 1 }, status: null, runtimeState: "running" },
  }) as Detail;

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

let calls: { method: string; url: string; body: unknown }[] = [];
let realFetch: typeof fetch;
beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : (input as Request).url;
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/config") && method === "GET") return Promise.resolve(json({ config: { FEATURE_X: "on" }, version: 1 }));
    if (url.endsWith("/secrets") && method === "GET") return Promise.resolve(json({ secrets: [] }));
    return Promise.resolve(json({ version: 2 }));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("AppPanels config table (L4)", () => {
  test("renders config with plaintext values + the non-secret note (gated on configure)", async () => {
    const r = render(wrap(<AppPanels d={detail(["configure"])} />));
    expect(await r.findByText("config (1)")).toBeTruthy();
    // value shown in PLAINTEXT (secrets never show a value, so this is unambiguous)
    expect((await r.findByDisplayValue("on"))).toBeTruthy();
    expect(r.getByText(/non-secret/)).toBeTruthy();
  });

  // add/edit/remove render the panel directly (the full AppPanels also mounts the secrets panel, whose
  // own "set"/delete controls would collide with these queries).
  test("add: setting KEY=value PUTs to the config endpoint", async () => {
    const r = render(wrap(<ConfigPanel name="billing" />));
    await r.findByText("config (1)");
    changeValue(r.getByLabelText("new config key"), "MAX_MB");
    changeValue(r.getByLabelText("new config value"), "25");
    fireEvent.click(r.getByRole("button", { name: "set" }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/config/MAX_MB"));
      expect(put).toBeTruthy();
      expect(put!.body).toEqual({ value: "25" });
    });
  });

  test("edit: changing a value PUTs the new value for that key", async () => {
    const r = render(wrap(<ConfigPanel name="billing" />));
    await r.findByText("config (1)");
    const input = await r.findByLabelText("value for FEATURE_X");
    changeValue(input, "off");
    fireEvent.blur(input);
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/config/FEATURE_X"));
      expect(put).toBeTruthy();
      expect(put!.body).toEqual({ value: "off" });
    });
  });

  test("remove: the ✕ DELETEs the key", async () => {
    const r = render(wrap(<ConfigPanel name="billing" />));
    await r.findByText("config (1)");
    fireEvent.click(r.getByRole("button", { name: "remove FEATURE_X" }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === "DELETE" && c.url.endsWith("/config/FEATURE_X"))).toBeTruthy();
    });
  });

  test("gated: without `configure` the config surface is not rendered", () => {
    const r = render(wrap(<AppPanels d={detail(["read"])} />));
    expect(r.queryByText(/^config \(/)).toBeNull();
    // and it never even polls the config endpoint
    expect(calls.find((c) => c.url.endsWith("/config"))).toBeUndefined();
  });
});
