// Smoke: SitePanels renders active previews (label, expiry, link) with a remove control for an
// owner, and stays hidden with no previews. Mirrors the ExposurePanel.test.tsx harness.
import { setupDom } from "../../test/setup.ts";
import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast.tsx";
import { makeQueryClient } from "../../lib/query.ts";
import { SitePanels } from "./SitePanels.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const base: Detail = {
  name: "mysite",
  type: "site",
  owner: "alice@example.com",
  collaborators: [],
  members: [{ email: "alice@example.com", role: "owner" }],
  visibility: "public",
  current: "v1",
  url: "https://mysite.drop.example.com",
  versions: [{ id: "v1", publishedBy: "alice@example.com", createdAt: "2026-01-01T00:00:00.000Z", fileCount: 3, bytes: 100 }],
  capabilities: ["read", "publish", "rollback"],
};

const withPreview = (caps: Detail["capabilities"] = ["read", "publish", "rollback"]): Detail => ({
  ...base,
  capabilities: caps,
  previews: [
    { label: "pr-42", versionId: "v2", url: "https://mysite--pr-42.drop.example.com", createdBy: "alice@example.com", createdAt: "2026-01-02T00:00:00.000Z", expiresAt: "2026-01-09T00:00:00.000Z" },
  ],
});

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

describe("SitePanels — previews", () => {
  test("no previews -> the previews section doesn't render", () => {
    const r = render(wrap(<SitePanels d={base} />));
    expect(r.queryByText(/previews \(/)).toBeNull();
  });

  test("an active preview shows its label, URL, and expiry, with a remove control when publish-capable", () => {
    const r = render(wrap(<SitePanels d={withPreview()} />));
    expect(r.getByText("previews (1)")).toBeTruthy();
    expect(r.getByText("pr-42")).toBeTruthy();
    expect(r.getByText("mysite--pr-42.drop.example.com")).toBeTruthy();
    expect(r.getByRole("button", { name: "remove" })).toBeTruthy();
  });

  test("clicking remove opens the confirm dialog", () => {
    const r = render(wrap(<SitePanels d={withPreview()} />));
    fireEvent.click(r.getByRole("button", { name: "remove" }));
    expect(r.getByText("Remove preview pr-42")).toBeTruthy();
  });

  test("without publish the preview shows but the remove control is hidden", () => {
    const r = render(wrap(<SitePanels d={withPreview(["read"])} />));
    expect(r.getByText("pr-42")).toBeTruthy();
    expect(r.queryByRole("button", { name: "remove" })).toBeNull();
  });
});
