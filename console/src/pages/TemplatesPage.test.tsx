// Smoke for the D1 template catalog: cards render from GET /v1/templates with name, description, and a
// visibility badge, each linking to /template/<slug>.
import { setupDom } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { makeQueryClient } from "../lib/query.ts";
import { TemplatesPage } from "./TemplatesPage.tsx";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const TEMPLATES = {
  templates: [
    { slug: "guestbook", name: "Guestbook", description: "Node app + Postgres", visibility: "public", org: null, latestVersion: "1", resources: 2, createdAt: "2026-07-04T00:00:00Z" },
    { slug: "internal-tool", name: "Internal Tool", description: null, visibility: "org", org: { slug: "acme", name: "Acme", kind: "team" }, latestVersion: "2", resources: 3, createdAt: "2026-07-04T00:00:00Z" },
  ],
};

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(json(TEMPLATES))) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const renderPage = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <TemplatesPage />
    </QueryClientProvider>,
  );

describe("TemplatesPage", () => {
  test("renders a card per template with name, description, visibility badge, and a deep link", async () => {
    const r = renderPage();
    const guestbook = (await r.findByText("Guestbook")).closest("a") as HTMLAnchorElement;
    expect(guestbook.getAttribute("href")).toBe("/template/guestbook");
    expect(within(guestbook).getByText("Node app + Postgres")).toBeTruthy();
    expect(within(guestbook).getByText("PUBLIC")).toBeTruthy();

    const tool = r.getByText("Internal Tool").closest("a") as HTMLAnchorElement;
    expect(tool.getAttribute("href")).toBe("/template/internal-tool");
    expect(within(tool).getByText("ORG")).toBeTruthy();
  });
});
