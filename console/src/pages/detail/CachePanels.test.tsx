// Smoke: CachePanels renders connection info + memory/persistence badges + the ephemerality warning.
import { setupDom } from "../../test/setup.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { CachePanels } from "./CachePanels.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const detail = (persistent: boolean): Detail =>
  ({
    name: "sessions",
    type: "cache",
    owner: "alice@example.com",
    collaborators: [],
    members: [{ email: "alice@example.com", role: "owner" }],
    visibility: "private",
    current: null,
    url: "https://sessions.x",
    versions: [],
    status: { status: "running", reason: "1/1 ready" },
    cache: { host: "sessions.ns.svc.cluster.local", port: 6379, memory: "256Mi", persistent, status: { replicas: 1, ready: 1, restarts: 0, reason: "Running" } },
  }) as Detail;

describe("CachePanels", () => {
  test("renders host + memory + an EPHEMERAL badge and the loud data-loss warning", () => {
    const r = render(<CachePanels d={detail(false)} />);
    expect(r.getByText("managed cache (valkey)")).toBeTruthy();
    expect(r.getByText("sessions.ns.svc.cluster.local:6379")).toBeTruthy();
    expect(r.getByText("256Mi")).toBeTruthy();
    expect(r.getByText("ephemeral")).toBeTruthy();
    expect(r.getByText(/EPHEMERAL — a restart/)).toBeTruthy();
  });

  test("a persistent cache shows a persistent badge and NO ephemerality warning", () => {
    const r = render(<CachePanels d={detail(true)} />);
    expect(r.getByText("persistent")).toBeTruthy();
    expect(r.queryByText(/EPHEMERAL — a restart/)).toBeNull();
  });
});
