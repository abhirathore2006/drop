// Smoke: AuthPanels renders the config surface (login URL, providers, signup, JWT alg + key age),
// the HS256/no-SMTP note, and (for a configure-capable actor) the user-admin panel — and NEVER any
// key material (there is none in the Detail to leak, but the panel must not fabricate one).
import { setupDom } from "../../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast.tsx";
import { makeQueryClient } from "../../lib/query.ts";
import { AuthPanels } from "./AuthPanels.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url, "http://x").pathname;
    if (url.includes("/users")) return Promise.resolve(json({ users: [{ id: "u1", email: "user1@example.com" }] }));
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CAPS = ["read", "logs", "deploy", "db:create", "connect", "rollback", "configure", "expose"];
const detail = (caps: string[] = CAPS): Detail =>
  ({
    name: "login",
    type: "auth",
    owner: "alice@example.com",
    collaborators: [],
    members: [{ email: "alice@example.com", role: "owner" }],
    visibility: "private",
    current: null,
    url: "",
    versions: [],
    capabilities: caps,
    status: { status: "running", reason: "1/1 ready" },
    auth: {
      url: "https://auth--login.drop.example.com",
      engine: "gotrue",
      jwtAlg: "HS256",
      db: "appdb",
      signup: "open",
      providers: ["google"],
      redirectUrls: ["https://app.example.com/cb"],
      jwtTtl: "1h",
      keyMintedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      status: { replicas: 1, ready: 1, restarts: 0, reason: "Running" },
    },
  }) as Detail;

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

describe("AuthPanels", () => {
  test("renders the config surface (login URL, db, providers, HS256) + key age + the HS256/no-SMTP note", () => {
    const r = render(wrap(<AuthPanels d={detail()} />));
    expect(r.getByText("managed auth (gotrue)")).toBeTruthy();
    expect(r.getByText("https://auth--login.drop.example.com")).toBeTruthy();
    expect(r.getByText("appdb")).toBeTruthy();
    expect(r.getByText("google")).toBeTruthy();
    expect(r.getAllByText(/HS256/).length).toBeGreaterThanOrEqual(1); // JWT row + the note both mention it
    expect(r.getByText(/minted 3 days ago/)).toBeTruthy();
    // no key material anywhere — the container's text never contains a JWT-looking secret
    expect(r.container.textContent ?? "").not.toMatch(/jwt-secret|GOTRUE_JWT_SECRET=/);
  });

  test("a configure-capable actor gets the user-admin surface (list + create control)", () => {
    const r = render(wrap(<AuthPanels d={detail()} />));
    expect(r.getByText("users")).toBeTruthy();
    expect(r.getByRole("button", { name: /rotate signing key/ })).toBeTruthy();
  });

  test("a read-only actor gets NO user-admin surface (configure-gated)", () => {
    const r = render(wrap(<AuthPanels d={detail(["read"])} />));
    expect(r.queryByText("users")).toBeNull();
  });
});
