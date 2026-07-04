// Smoke: WorkloadFrame gates PURELY on server-computed d.capabilities (M2). The danger zone is
// HIDDEN without delete/transfer; a role-gated action (deploy → restart/stop) is DISABLED with a
// tooltip when the actor lacks the verb.
import { setupDom } from "../../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast.tsx";
import { makeQueryClient } from "../../lib/query.ts";
import { WorkloadFrame } from "./WorkloadFrame.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(json({}))) as unknown as typeof fetch; // MetricsPanel etc. never hit a real server
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const appDetail = (caps: Detail["capabilities"]): Detail =>
  ({
    name: "web",
    type: "app",
    owner: "alice@example.com",
    collaborators: [],
    members: [{ email: "alice@example.com", role: "owner" }],
    visibility: "private",
    current: null,
    url: "https://web.x",
    versions: [],
    capabilities: caps,
    status: { status: "running", reason: "healthy" },
    app: { image: "img:1", scale: { min: 1, max: 3 }, resources: null, status: null, runtimeState: "running" },
  }) as Detail;

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

describe("WorkloadFrame capability gating (M2)", () => {
  test("without delete/transfer the danger zone is HIDDEN; without deploy the lifecycle button is DISABLED with a tooltip", () => {
    const r = render(wrap(<WorkloadFrame d={appDetail(["read"])} />));
    // danger zone hidden
    expect(r.queryByText("danger")).toBeNull();
    expect(r.queryByRole("button", { name: /delete/ })).toBeNull();
    // deploy-gated lifecycle button present but disabled + tooltip
    const restart = r.getByRole("button", { name: "restart" }) as HTMLButtonElement;
    expect(restart.disabled).toBe(true);
    expect(restart.getAttribute("title")).toMatch(/deploy/);
  });

  test("with the full capability set the danger zone shows and the lifecycle button is enabled", () => {
    const full: Detail["capabilities"] = ["read", "logs", "publish", "deploy", "db:create", "connect", "rollback", "configure", "expose", "share", "transfer", "delete"];
    const r = render(wrap(<WorkloadFrame d={appDetail(full)} />));
    expect(r.getByText("danger")).toBeTruthy();
    expect(r.getByRole("button", { name: /delete app/ })).toBeTruthy();
    const restart = r.getByRole("button", { name: "restart" }) as HTMLButtonElement;
    expect(restart.disabled).toBe(false);
    expect(restart.getAttribute("title")).toBeNull();
  });
});
