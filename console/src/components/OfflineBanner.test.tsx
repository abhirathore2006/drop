// (M5) The offline / API-down banner: the query layer's transport-error detection flips it, a
// success clears it, and the component shows/hides accordingly.
import { setupDom } from "../test/setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { OfflineBanner } from "./OfflineBanner.tsx";
import { networkStatus, reportNetworkResult } from "../lib/query.ts";
import { ApiError } from "../lib/api.ts";

setupDom();

// Keep the banner's recovery ping from touching the network / auto-clearing during a test.
const realFetch = globalThis.fetch;
beforeEach(() => {
  reportNetworkResult(null); // reset the shared store to "online"
  globalThis.fetch = (() => Promise.reject(new TypeError("still offline"))) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  reportNetworkResult(null);
});

const goOffline = () =>
  act(() => {
    // Two consecutive transport failures trip the offline threshold.
    reportNetworkResult(new TypeError("Failed to fetch"));
    reportNetworkResult(new TypeError("Failed to fetch"));
  });

describe("offline detection (query layer)", () => {
  test("a single transport error does NOT trip offline; two do", () => {
    expect(networkStatus.getSnapshot()).toBe(false);
    reportNetworkResult(new TypeError("Failed to fetch"));
    expect(networkStatus.getSnapshot()).toBe(false);
    reportNetworkResult(new TypeError("Failed to fetch"));
    expect(networkStatus.getSnapshot()).toBe(true);
  });

  test("an HTTP error (server answered) never trips offline", () => {
    reportNetworkResult(new ApiError("boom", 500));
    reportNetworkResult(new ApiError("boom", 500));
    expect(networkStatus.getSnapshot()).toBe(false);
  });

  test("a success clears the offline flag", () => {
    reportNetworkResult(new TypeError("x"));
    reportNetworkResult(new TypeError("x"));
    expect(networkStatus.getSnapshot()).toBe(true);
    reportNetworkResult(null);
    expect(networkStatus.getSnapshot()).toBe(false);
  });
});

describe("OfflineBanner", () => {
  test("renders nothing while online", () => {
    const r = render(<OfflineBanner />);
    expect(r.queryByText(/Can.t reach Drop/)).toBeNull();
  });

  test("shows the banner when offline and hides it on recovery", () => {
    const r = render(<OfflineBanner />);
    expect(r.queryByText(/Can.t reach Drop/)).toBeNull();

    goOffline();
    expect(r.getByText(/Can.t reach Drop/)).toBeTruthy();
    expect(r.getByRole("status")).toBeTruthy();

    act(() => reportNetworkResult(null));
    expect(r.queryByText(/Can.t reach Drop/)).toBeNull();
  });
});
