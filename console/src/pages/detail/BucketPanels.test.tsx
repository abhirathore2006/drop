// Smoke: BucketPanels renders connection info + size, and offers credential rotation to owners.
import { setupDom } from "../../test/setup.ts";
import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast.tsx";
import { makeQueryClient } from "../../lib/query.ts";
import { BucketPanels } from "./BucketPanels.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const detail = (objects: number, caps: string[] = ["read", "configure"]): Detail =>
  ({
    name: "avatars",
    type: "bucket",
    owner: "alice@example.com",
    collaborators: [],
    members: [{ email: "alice@example.com", role: "owner" }],
    visibility: "private",
    current: null,
    url: "https://avatars.x",
    versions: [],
    capabilities: caps,
    bucket: { endpoint: "http://s3.local", bucket: "platform-bucket", prefix: "buckets/ns/avatars/", bytes: 4096, objects },
  }) as Detail;

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

describe("BucketPanels", () => {
  test("renders endpoint/bucket/prefix + size and an enabled rotate control with `configure`", () => {
    const r = render(wrap(<BucketPanels d={detail(3)} />));
    expect(r.getByText("object storage")).toBeTruthy();
    expect(r.getByText("platform-bucket")).toBeTruthy();
    expect(r.getByText("buckets/ns/avatars/")).toBeTruthy();
    expect(r.getByText(/4\.0 KiB · 3 objects/)).toBeTruthy();
    expect((r.getByRole("button", { name: "rotate credentials" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("without `configure` the rotate control is disabled (with a tooltip), not gone", () => {
    const r = render(wrap(<BucketPanels d={detail(0, ["read"])} />));
    expect(r.getByText(/0 objects/)).toBeTruthy();
    const btn = r.getByRole("button", { name: "rotate credentials" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toMatch(/configure/);
  });

  test("clicking rotate opens the confirm dialog", () => {
    const r = render(wrap(<BucketPanels d={detail(1)} />));
    fireEvent.click(r.getByRole("button", { name: "rotate credentials" }));
    expect(r.getByText("Rotate bucket credentials")).toBeTruthy();
  });
});
