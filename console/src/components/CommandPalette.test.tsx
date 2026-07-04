// Keyboard flow for the palette body (PaletteBox) with injected commands — no router or
// query layer needed, since the command list is a prop.
import { changeValue, setupDom } from "../test/setup.ts";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { PaletteBox, type Command } from "./CommandPalette.tsx";

setupDom();

function commands(runs: { app?: () => void; db?: () => void; stacks?: () => void }): Command[] {
  return [
    { id: "app", label: "my-app", hint: "app", run: runs.app ?? (() => {}) },
    { id: "db", label: "my-db", hint: "database", run: runs.db ?? (() => {}) },
    { id: "stacks", label: "go to stacks", hint: "go", run: runs.stacks ?? (() => {}) },
  ];
}

describe("PaletteBox", () => {
  test("fuzzy-filters the list as you type; Enter runs the top match and closes", () => {
    const app = mock(() => {});
    const onClose = mock(() => {});
    const r = render(<PaletteBox commands={commands({ app })} onClose={onClose} />);
    const input = r.getByRole("combobox");

    changeValue(input, "myapp");
    // only my-app survives the filter
    expect(r.getByText("my-app")).toBeTruthy();
    expect(r.queryByText("go to stacks")).toBeNull();
    expect(r.queryByText("my-db")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(app).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("ArrowDown moves the selection before Enter runs it", () => {
    const app = mock(() => {});
    const db = mock(() => {});
    const r = render(<PaletteBox commands={commands({ app, db })} onClose={() => {}} />);
    const input = r.getByRole("combobox");

    // no query → order is [my-app, my-db, go to stacks]; ArrowDown selects my-db
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(db).toHaveBeenCalledTimes(1);
    expect(app).not.toHaveBeenCalled();
  });

  test("ArrowUp wraps to the last item", () => {
    const stacks = mock(() => {});
    const r = render(<PaletteBox commands={commands({ stacks })} onClose={() => {}} />);
    const input = r.getByRole("combobox");
    // from the first item, ArrowUp wraps to the last (go to stacks)
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(stacks).toHaveBeenCalledTimes(1);
  });

  test("a query with no matches shows the empty hint", () => {
    const r = render(<PaletteBox commands={commands({})} onClose={() => {}} />);
    changeValue(r.getByRole("combobox"), "zzzzz");
    expect(r.getByText("no matches")).toBeTruthy();
  });
});
