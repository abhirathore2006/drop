// Smoke: the DbPanels pooler row (I3) — off shows an enable control; on shows mode + host + disable.
import { setupDom } from "../../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast.tsx";
import { makeQueryClient } from "../../lib/query.ts";
import { DbPanels } from "./DbPanels.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url, "http://x").pathname;
    if (url.includes("/backups")) return Promise.resolve(json({ backups: [], lastSuccessAt: null }));
    if (url.includes("/logs")) return Promise.resolve(json({ logs: "" }));
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const detail = (pooler?: { enabled: boolean; mode?: string; host?: string }, extensions?: string[]): Detail =>
  ({
    name: "pgdb",
    type: "database",
    owner: "alice@example.com",
    collaborators: [],
    members: [{ email: "alice@example.com", role: "owner" }],
    visibility: "private",
    current: null,
    url: "",
    versions: [],
    status: { status: "running", reason: "healthy" },
    database: {
      host: "pgdb-rw.ns.svc.cluster.local",
      port: 5432,
      database: "app",
      user: "app",
      credentialsSecret: "pgdb-app",
      status: { phase: "Cluster in healthy state", ready: 1, instances: 1, hibernated: false },
      extensions,
      pooler,
    },
  }) as Detail;

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

describe("DbPanels pooler row (I3)", () => {
  test("pooler off → an enable control is offered to an editor", () => {
    const r = render(wrap(<DbPanels d={detail({ enabled: false })} isOwner={true} canDeploy={true} />));
    expect(r.getByText("pooler")).toBeTruthy();
    expect(r.getByRole("button", { name: /enable/ })).toBeTruthy();
  });

  test("pooler on → shows mode + host + a disable control", () => {
    const r = render(wrap(<DbPanels d={detail({ enabled: true, mode: "transaction", host: "pgdb-pooler-rw.ns.svc.cluster.local" })} isOwner={true} canDeploy={true} />));
    expect(r.getByText(/transaction/)).toBeTruthy();
    expect(r.getByText("pgdb-pooler-rw.ns.svc.cluster.local")).toBeTruthy();
    expect(r.getByRole("button", { name: "disable" })).toBeTruthy();
  });

  test("extensions are listed when present", () => {
    const r = render(wrap(<DbPanels d={detail({ enabled: false }, ["pgvector", "pg_trgm"])} isOwner={true} canDeploy={true} />));
    expect(r.getByText("pgvector, pg_trgm")).toBeTruthy();
  });
});
