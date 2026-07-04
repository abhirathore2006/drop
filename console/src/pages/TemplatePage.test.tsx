// Smoke for the D1 template detail page: the readme renders, the variables form gates the Deploy button
// until required variables are filled, and the canvas-preview legend renders the node names (the heavy
// @xyflow canvas is code-split behind React.lazy and doesn't render meaningfully under happy-dom, so — as
// in StackPage.test — we assert on the always-rendered legend).
import { setupDom, changeValue } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { makeQueryClient } from "../lib/query.ts";
import { TemplatePage } from "./TemplatePage.tsx";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const DETAIL = {
  slug: "guestbook",
  name: "Guestbook",
  description: "A guestbook",
  visibility: "public",
  org: null,
  version: "1",
  versions: ["1"],
  variables: [
    { key: "session", description: "app session secret", required: true, secret: true },
    { key: "size", description: "db size", required: false, default: "1Gi" },
  ],
  readme: "# Welcome\nA tiny app.",
  spec: {
    name: "guestbook",
    resources: {
      db: { type: "database", storage: "1Gi" },
      web: { type: "app", image: "web:1", uses: [{ database: "db" }] },
    },
  },
};

let realFetch: typeof fetch;
beforeEach(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(json(DETAIL))) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const renderPage = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <TemplatePage slug="guestbook" />
    </QueryClientProvider>,
  );

describe("TemplatePage", () => {
  test("renders the readme and the canvas-preview legend node names", async () => {
    const r = renderPage();
    expect(await r.findByText("A tiny app.")).toBeTruthy(); // readme paragraph
    expect(r.getByText("Welcome")).toBeTruthy(); // readme heading
    // preview legend carries the node keys (rendered without the lazy canvas chunk)
    const legend = within(r.container.querySelector(".template-legend") as HTMLElement);
    expect(legend.getByText("db")).toBeTruthy();
    expect(legend.getByText("web")).toBeTruthy();
  });

  test("the variables form gates the Deploy button until required variables are filled", async () => {
    const r = renderPage();
    await r.findByText("A tiny app.");
    const deploy = r.getByRole("button", { name: "Deploy this stack" }) as HTMLButtonElement;
    // required `session` is empty → deploy is disabled
    expect(deploy.disabled).toBe(true);
    // fill it → deploy enables
    changeValue(r.getByLabelText("session"), "top-secret");
    expect(deploy.disabled).toBe(false);
  });
});
