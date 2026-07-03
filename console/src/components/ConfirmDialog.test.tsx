import { changeValue, setupDom } from "../test/setup.ts";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

setupDom();

describe("ConfirmDialog", () => {
  test("without type-the-name, confirm is immediately enabled and fires", () => {
    const onConfirm = mock(() => {});
    const r = render(
      <ConfirmDialog open title="Transfer mysite" confirmLabel="transfer" onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const btn = r.getByRole("button", { name: "transfer" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("type-the-name gates the confirm button until the exact name is typed", () => {
    const onConfirm = mock(() => {});
    const r = render(
      <ConfirmDialog
        open
        title="Delete mysite"
        confirmLabel="delete site"
        danger
        typeToConfirm="mysite"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const btn = r.getByRole("button", { name: "delete site" }) as HTMLButtonElement;
    const input = r.getByPlaceholderText("mysite");

    // gated while empty
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();

    // wrong name stays gated (near-miss included)
    changeValue(input, "mysit");
    expect(btn.disabled).toBe(true);
    changeValue(input, "other-site");
    expect(btn.disabled).toBe(true);

    // exact name unlocks
    changeValue(input, "mysite");
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("escape and cancel call onCancel, not onConfirm", () => {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    const r = render(
      <ConfirmDialog open title="Delete x" confirmLabel="delete" typeToConfirm="x" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.click(r.getByRole("button", { name: "cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("closed dialog renders nothing", () => {
    const r = render(
      <ConfirmDialog open={false} title="Delete x" confirmLabel="delete" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(r.queryByRole("dialog")).toBeNull();
  });
});
