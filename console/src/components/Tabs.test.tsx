// (M5) Tabs a11y: ARIA tab semantics, roving tabindex, and arrow-key navigation.
import { setupDom } from "../test/setup.ts";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { Tabs } from "./Tabs.tsx";

setupDom();

const TABS = [
  { id: "a", label: "alpha" },
  { id: "b", label: "beta" },
  { id: "c", label: "gamma" },
] as const;

describe("Tabs", () => {
  test("exposes tablist/tab roles with aria-selected on the active tab", () => {
    const r = render(<Tabs tabs={[...TABS]} active="b" onChange={() => {}} label="sections" />);
    expect(r.getByRole("tablist", { name: "sections" })).toBeTruthy();
    const tabs = r.getAllByRole("tab");
    expect(tabs.length).toBe(3);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("false");
  });

  test("roving tabindex: only the active tab is in the tab order", () => {
    const r = render(<Tabs tabs={[...TABS]} active="b" onChange={() => {}} />);
    const tabs = r.getAllByRole("tab");
    expect(tabs[0]!.getAttribute("tabindex")).toBe("-1");
    expect(tabs[1]!.getAttribute("tabindex")).toBe("0");
    expect(tabs[2]!.getAttribute("tabindex")).toBe("-1");
  });

  test("ArrowRight activates the next tab; wraps at the end", () => {
    const onChange = mock((_: string) => {});
    const r = render(<Tabs tabs={[...TABS]} active="a" onChange={onChange} />);
    const tabs = r.getAllByRole("tab");
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");

    const r2 = render(<Tabs tabs={[...TABS]} active="c" onChange={onChange} />);
    fireEvent.keyDown(r2.getAllByRole("tab")[2]!, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("a"); // wrapped
  });

  test("ArrowLeft moves back; Home/End jump to the ends", () => {
    const onChange = mock((_: string) => {});
    const r = render(<Tabs tabs={[...TABS]} active="b" onChange={onChange} />);
    const tabs = r.getAllByRole("tab");
    fireEvent.keyDown(tabs[1]!, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(tabs[1]!, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  test("clicking a tab selects it", () => {
    const onChange = mock((_: string) => {});
    const r = render(<Tabs tabs={[...TABS]} active="a" onChange={onChange} />);
    fireEvent.click(r.getByRole("tab", { name: "gamma" }));
    expect(onChange).toHaveBeenLastCalledWith("c");
  });
});
