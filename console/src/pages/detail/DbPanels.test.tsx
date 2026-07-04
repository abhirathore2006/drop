// Smoke: the DbPanels pooler row (I3) — off shows an enable control; on shows mode + host + disable.
// Plus (I4) the SQL console panel: gated on `query`, runs a query, renders a grid, shows errors.
import { setupDom, changeValue } from "../../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
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

// Full editor+configure capability set so every gated control renders enabled.
const CAPS = ["read", "logs", "deploy", "db:create", "connect", "rollback", "configure", "expose"];
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
    capabilities: CAPS,
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

// (I4) A detail WITH the `query` capability → the SQL console panel renders (CAPS above deliberately
// omits it, so the base `detail()` exercises the hidden-without-capability path).
const withQuery = (): Detail => ({ ...detail({ enabled: false }), capabilities: [...CAPS, "query"] as Detail["capabilities"] });

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

describe("DbPanels pooler row (I3)", () => {
  test("pooler off → an enable control is offered to an editor", () => {
    const r = render(wrap(<DbPanels d={detail({ enabled: false })} />));
    expect(r.getByText("pooler")).toBeTruthy();
    expect(r.getByRole("button", { name: /enable/ })).toBeTruthy();
  });

  test("pooler on → shows mode + host + a disable control", () => {
    const r = render(wrap(<DbPanels d={detail({ enabled: true, mode: "transaction", host: "pgdb-pooler-rw.ns.svc.cluster.local" })} />));
    expect(r.getByText(/transaction/)).toBeTruthy();
    expect(r.getByText("pgdb-pooler-rw.ns.svc.cluster.local")).toBeTruthy();
    expect(r.getByRole("button", { name: "disable" })).toBeTruthy();
  });

  test("extensions are listed when present", () => {
    const r = render(wrap(<DbPanels d={detail({ enabled: false }, ["pgvector", "pg_trgm"])} />));
    expect(r.getByText("pgvector, pg_trgm")).toBeTruthy();
  });
});

describe("DbPanels SQL console (I4)", () => {
  test("hidden without the `query` capability", () => {
    const r = render(wrap(<DbPanels d={detail({ enabled: false })} />)); // CAPS omits "query"
    expect(r.queryByText("SQL console")).toBeNull();
  });

  test("visible with `query` — shows the permanent read-only banner + a Run control", () => {
    const r = render(wrap(<DbPanels d={withQuery()} />));
    expect(r.getByText("SQL console")).toBeTruthy();
    expect(r.getByText("read-only · audited · 5s timeout · 500 rows")).toBeTruthy();
    expect(r.getByRole("button", { name: /Run/ })).toBeTruthy();
  });

  // A URL-aware fetch: the side panels (backups/logs) keep their own shapes; only /query is scripted.
  const mockWith = (query: () => Promise<Response>) => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url, "http://x").pathname;
      if (url.includes("/query")) return query();
      if (url.includes("/backups")) return Promise.resolve(json({ backups: [], lastSuccessAt: null }));
      if (url.includes("/logs")) return Promise.resolve(json({ logs: "" }));
      return Promise.resolve(json({}));
    }) as unknown as typeof fetch;
  };

  test("running a query renders the result grid (columns + rows + row/time footer)", async () => {
    mockWith(() => Promise.resolve(json({ columns: [{ name: "id" }, { name: "email" }], rows: [[1, "a@x.com"], [2, "b@x.com"]], rowCount: 2, truncated: false, elapsedMs: 4 })));
    const r = render(wrap(<DbPanels d={withQuery()} />));
    changeValue(r.getByLabelText("SQL query"), "select id, email from users");
    fireEvent.click(r.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(r.getByText("a@x.com")).toBeTruthy());
    expect(r.getByText("email")).toBeTruthy(); // a column header
    expect(r.getByText("b@x.com")).toBeTruthy(); // a second-row cell
    expect(r.getByText(/2 rows/)).toBeTruthy(); // footer
  });

  test("a SQL error shows inline (no grid)", async () => {
    mockWith(() => Promise.resolve(new Response(JSON.stringify({ error: 'relation "nope" does not exist' }), { status: 400, headers: { "content-type": "application/json" } })));
    const r = render(wrap(<DbPanels d={withQuery()} />));
    changeValue(r.getByLabelText("SQL query"), "select * from nope");
    fireEvent.click(r.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(r.getByText('relation "nope" does not exist')).toBeTruthy());
  });
});
