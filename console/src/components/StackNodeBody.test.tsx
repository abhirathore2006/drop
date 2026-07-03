// Node-body render in isolation (no @xyflow): name/type/status-dot/version + the pending overlay.
import { setupDom } from "../test/setup.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import type { GraphNode } from "../lib/api.ts";
import { StackNodeBody } from "./StackNodeBody.tsx";

setupDom();

const node: GraphNode = {
  key: "api",
  siteName: "shop-api",
  type: "app",
  url: "https://shop-api.x",
  currentVersion: "v_1700000000_abc123",
  exists: true,
  status: { status: "running", reason: "1/1 ready" },
};

describe("StackNodeBody", () => {
  test("renders key, site name, a green dot for running, and the short version", () => {
    const r = render(<StackNodeBody node={node} />);
    expect(r.getByText("api")).toBeTruthy();
    expect(r.getByText("shop-api")).toBeTruthy();
    expect(r.getByText("#abc123")).toBeTruthy();
    // the status dot carries the green (running) class
    expect(r.container.querySelector(".sdot-green")).toBeTruthy();
    // no pending styling by default
    expect(r.container.querySelector(".snode-pending")).toBeNull();
  });

  test("a red dot for an errored node", () => {
    const r = render(<StackNodeBody node={{ ...node, status: { status: "error", reason: "CrashLoopBackOff" } }} />);
    expect(r.container.querySelector(".sdot-red")).toBeTruthy();
  });

  test("a pending action adds a dashed outline + an action tag", () => {
    const r = render(<StackNodeBody node={{ ...node, exists: false }} pending="create" />);
    expect(r.container.querySelector(".snode-pending")).toBeTruthy();
    expect(r.container.querySelector(".snode-missing")).toBeTruthy();
    expect(r.getByText("create")).toBeTruthy();
  });
});
