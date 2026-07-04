// Smoke: LogsPanel over a mocked fetch-stream. The follow endpoint is faked with a ReadableStream that
// emits a couple of lines; we assert they render, that the grep box filters them, and that the follow /
// download affordances are present. xterm/WS aren't involved here (that's TerminalPanel).
import { setupDom, changeValue } from "../../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { makeQueryClient } from "../../lib/query.ts";
import { LogsPanel } from "./LogsPanel.tsx";

setupDom();

const json = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response);
const streamOf = (text: string) =>
  Promise.resolve({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
  } as unknown as Response);

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL((input as Request).url, "http://x").pathname;
    // (G4) history search returns JSON, not a stream — must be checked before the live-tail branch.
    if (url.includes("/logs/search")) return json({ lines: [{ ts: "2026-07-04T10:00:00Z", pod: "app1", line: "historical hit" }], truncated: false, scanned: 1 });
    if (url.includes("/logs")) return streamOf("line one\nline two\n");
    if (url.includes("/processes")) return json({ name: "app1", runtimeState: "running", processes: [] });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const wrap = (node: React.ReactNode) => <QueryClientProvider client={makeQueryClient()}>{node}</QueryClientProvider>;

describe("LogsPanel (M3 live logs)", () => {
  test("streamed lines render into the log view", async () => {
    const r = render(wrap(<LogsPanel name="app1" type="app" />));
    await waitFor(() => expect(r.getByText("line one")).toBeTruthy());
    expect(r.getByText("line two")).toBeTruthy();
  });

  test("the grep box filters the rendered lines", async () => {
    const r = render(wrap(<LogsPanel name="app1" type="app" />));
    await waitFor(() => expect(r.getByText("line one")).toBeTruthy());
    changeValue(r.getByLabelText("filter logs"), "two");
    await waitFor(() => expect(r.queryByText("line one")).toBeNull());
    expect(r.getByText("line two")).toBeTruthy();
  });

  test("follow + download affordances are present", async () => {
    const r = render(wrap(<LogsPanel name="app1" type="app" />));
    await waitFor(() => expect(r.getByText("line one")).toBeTruthy());
    expect(r.getByRole("button", { name: "following" })).toBeTruthy();
    expect(r.getByRole("button", { name: "download" })).toBeTruthy();
  });

  test("(G4) history mode searches the retained objects and renders the hits; live tail still available", async () => {
    const r = render(wrap(<LogsPanel name="app1" type="app" />));
    await waitFor(() => expect(r.getByText("line one")).toBeTruthy());
    // switch to history mode → the live grep is replaced by the range + search controls
    fireEvent.click(r.getByRole("button", { name: "history" }));
    expect(r.getByLabelText("search history")).toBeTruthy();
    expect(r.getByLabelText("time range")).toBeTruthy();
    // run a search → the mocked JSON hit renders
    changeValue(r.getByLabelText("search history"), "hit");
    fireEvent.click(r.getByRole("button", { name: "search" }));
    await waitFor(() => expect(r.getByText("historical hit")).toBeTruthy());
    // the live/history toggle is still present (the live tail is one click away)
    expect(r.getByRole("button", { name: "live" })).toBeTruthy();
  });
});
