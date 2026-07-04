// (F2) Prompt-box smoke for the AI-intent entry on the stacks page. Enabled → the box renders and Generate
// loads the returned spec into the C2 editor as pending changes (guardrail banner + editing toolbar appear).
// Disabled → the box is hidden. The heavy @xyflow canvas is code-split; we assert on the always-eager
// surfaces (prompt box, guardrail note, editor toolbar), never the canvas itself.
import { setupDom, changeValue } from "../test/setup.ts";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast.tsx";
import { makeQueryClient } from "../lib/query.ts";
import { StacksPage } from "./StacksPage.tsx";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const GENERATED = { spec: { name: "shop", resources: { api: { type: "app", image: "ghcr.io/x/api:1" } } }, notes: ["assumed a single web service"] };

let realFetch: typeof fetch;
let features: { llmEnabled: boolean };
let generateCalls: string[];
beforeEach(() => {
  features = { llmEnabled: true };
  generateCalls = [];
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const full = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL((input as Request).url, "http://x").pathname;
    const url = full.split("?")[0]!;
    if (url === "/v1/features") return Promise.resolve(json(features));
    if (url === "/v1/orgs") return Promise.resolve(json({ orgs: [] }));
    if (url === "/v1/stacks/generate") {
      generateCalls.push(init?.body as string);
      return Promise.resolve(json(GENERATED));
    }
    if (url === "/v1/stacks") return Promise.resolve(json({ stacks: [] }));
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
        <StacksPage />
      </ToastProvider>
    </QueryClientProvider>,
  );

describe("StacksPage AI intent (F2)", () => {
  test("enabled: the prompt box renders and Generate loads the spec into the editor as pending changes", async () => {
    const r = renderPage();
    const input = (await r.findByTestId("ai-stack-prompt-input")) as HTMLTextAreaElement;
    changeValue(input, "a node api with a postgres database");
    const btn = await r.findByTestId("ai-generate-btn");
    fireEvent.click(btn);
    // The generated spec seeds the C2 editor: the guardrail banner + the editing toolbar appear.
    const guardrail = await r.findByTestId("ai-guardrail");
    expect(guardrail.textContent).toContain("review before applying");
    expect(guardrail.textContent).toContain("assumed a single web service"); // the AI note rides through
    expect(r.getByText("editing")).toBeTruthy(); // StackEditor toolbar pill
    // The generate request carried the prompt.
    expect(generateCalls.length).toBe(1);
    expect(JSON.parse(generateCalls[0]!).prompt).toContain("postgres");
  });

  test("disabled: the prompt box is hidden", async () => {
    features = { llmEnabled: false };
    const r = renderPage();
    await r.findByText(/Stacks/); // page rendered
    // give the /v1/features query a tick to resolve to llmEnabled:false
    await new Promise((res) => setTimeout(res, 0));
    expect(r.queryByTestId("ai-stack-prompt")).toBeNull();
    expect(r.queryByTestId("ai-stack-prompt-input")).toBeNull();
  });
});
