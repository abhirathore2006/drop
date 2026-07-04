// Smoke: TerminalPanel's secrets-ack gate — the one-time-per-app confirm must appear BEFORE any connect
// (no ticket fetch, no WebSocket, no xterm). xterm rendering / the WS bridge aren't exercised here
// (happy-dom has no canvas); the exec adapter is covered exhaustively in ../../lib/exec-stream.test.ts.
import { setupDom } from "../../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { TerminalPanel } from "./TerminalPanel.tsx";
import type { Detail } from "../../lib/api.ts";

setupDom();

// The ack-gate tests never reach a real connect; the acked path DOES start a session, so stub fetch to
// fail the exec-ticket request fast + deterministically (the connect aborts before any xterm import).
let realFetch: typeof fetch;
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("no server in test"))) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const app = (): Detail =>
  ({
    name: "web1",
    type: "app",
    owner: "alice@example.com",
    collaborators: [],
    members: [],
    visibility: "private",
    current: null,
    url: "",
    versions: [],
    capabilities: ["read", "logs", "exec"],
    app: { image: "img:1", scale: { min: 1, max: 1 }, status: null },
  }) as Detail;

describe("TerminalPanel secrets-ack gate", () => {
  test("initially closed — offers an open-shell button, no terminal", () => {
    const r = render(<TerminalPanel d={app()} />);
    expect(r.getByRole("button", { name: "open shell" })).toBeTruthy();
    expect(r.container.querySelector(".terminal")).toBeNull();
  });

  test("clicking open shell (never acked) shows the secrets warning BEFORE connecting", () => {
    const r = render(<TerminalPanel d={app()} />);
    fireEvent.click(r.getByRole("button", { name: "open shell" }));
    // the one-time confirm dialog — not a terminal/connection
    expect(r.getByText("Open a shell into this app")).toBeTruthy();
    expect(r.getByText("write-only injected secrets")).toBeTruthy();
    expect(r.container.querySelector(".terminal")).toBeNull();
  });

  test("cancelling the confirm closes it and leaves the session closed", () => {
    const r = render(<TerminalPanel d={app()} />);
    fireEvent.click(r.getByRole("button", { name: "open shell" }));
    fireEvent.click(r.getByRole("button", { name: "cancel" }));
    expect(r.queryByText("Open a shell into this app")).toBeNull();
    expect(r.container.querySelector(".terminal")).toBeNull();
  });

  test("a prior ack skips the dialog (no confirm shown on open)", () => {
    localStorage.setItem("drop.exec.ack.web1", "1");
    const r = render(<TerminalPanel d={app()} />);
    fireEvent.click(r.getByRole("button", { name: "open shell" }));
    // acked → straight to a session (dialog never appears); the terminal container mounts.
    expect(r.queryByText("Open a shell into this app")).toBeNull();
  });
});
