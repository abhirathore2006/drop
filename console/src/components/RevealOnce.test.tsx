import { setupDom } from "../test/setup.ts";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { RevealOnce } from "./RevealOnce.tsx";

setupDom();

describe("RevealOnce", () => {
  test("shows the secret with its note and warning until explicitly dismissed", () => {
    const r = render(<RevealOnce value="s3cr3t-pw" note="shown once — copy it now." warning="Secret didn't sync" />);
    expect(r.getByText("s3cr3t-pw")).toBeTruthy();
    expect(r.getByText("shown once — copy it now.")).toBeTruthy();
    expect(r.getByText(/Secret didn't sync/)).toBeTruthy();
    // no auto-hide: still visible after a re-query
    expect(r.getByText("s3cr3t-pw")).toBeTruthy();
  });

  test("'I saved it' dismisses for good and calls onDismiss (show-once semantics)", () => {
    const onDismiss = mock(() => {});
    const r = render(<RevealOnce value="s3cr3t-pw" onDismiss={onDismiss} />);
    fireEvent.click(r.getByRole("button", { name: "I saved it" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // the value is gone and cannot come back — only the tombstone remains
    expect(r.queryByText("s3cr3t-pw")).toBeNull();
    expect(r.getByText("saved — not shown again")).toBeTruthy();
    expect(r.queryByRole("button", { name: "copy" })).toBeNull();
  });

  test("copy button exists while revealed", () => {
    const r = render(<RevealOnce value="s3cr3t-pw" />);
    expect(r.getByRole("button", { name: "copy" })).toBeTruthy();
  });
});
