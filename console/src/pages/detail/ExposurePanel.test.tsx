// Smoke: ExposurePanel shows the connect string when exposed (with an unexpose control for a
// deployer), and offers a mode/protocol picker + expose button when not.
import { setupDom } from "../../test/setup.ts";
import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast.tsx";
import { makeQueryClient } from "../../lib/query.ts";
import { ExposurePanel } from "./ExposurePanel.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

const base: Detail = {
  name: "pg",
  type: "database",
  owner: "alice@example.com",
  collaborators: [],
  members: [{ email: "alice@example.com", role: "owner" }],
  visibility: "private",
  current: null,
  url: "https://pg.x",
  versions: [],
  capabilities: ["read", "expose"],
} as Detail;

const exposed = (): Detail => ({ ...base, tcp: { mode: "sni", port: null, protocol: "postgres", connect: "pg.drop.example.com:5432", sslmode: "connect with sslmode=require" } });

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

describe("ExposurePanel", () => {
  test("renders the connect string + unexpose control for an exposed workload (expose-capable)", () => {
    const r = render(wrap(<ExposurePanel d={exposed()} />));
    expect(r.getByText("tcp exposure")).toBeTruthy();
    expect(r.getByText("pg.drop.example.com:5432")).toBeTruthy();
    expect(r.getByText(/sslmode=require/)).toBeTruthy();
    expect(r.getByRole("button", { name: "unexpose" })).toBeTruthy();
  });

  test("clicking unexpose opens the confirm dialog", () => {
    const r = render(wrap(<ExposurePanel d={exposed()} />));
    fireEvent.click(r.getByRole("button", { name: "unexpose" }));
    expect(r.getByText("Unexpose pg")).toBeTruthy();
  });

  test("an unexposed workload shows the expose picker when expose-capable", () => {
    const r = render(wrap(<ExposurePanel d={base} />));
    expect(r.getByText(/not exposed/)).toBeTruthy();
    expect(r.getByRole("button", { name: "expose" })).toBeTruthy();
    expect(r.getByText("sni (shared port)")).toBeTruthy(); // the mode picker option
  });

  test("without the expose verb, the state shows but the expose control is hidden", () => {
    const r = render(wrap(<ExposurePanel d={{ ...base, capabilities: ["read"] }} />));
    expect(r.getByText(/not exposed/)).toBeTruthy();
    expect(r.queryByRole("button", { name: "expose" })).toBeNull();
  });
});
