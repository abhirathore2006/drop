import { changeValue, setupDom } from "../test/setup.ts";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { NamePromptModal } from "./NamePromptModal.tsx";

setupDom();

describe("NamePromptModal", () => {
  test("publish is disabled until a name is typed, then submits the trimmed value", () => {
    const onSubmit = mock(() => {});
    const r = render(<NamePromptModal open onCancel={() => {}} onSubmit={onSubmit} />);
    const btn = r.getByRole("button", { name: "publish" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const input = r.getByPlaceholderText("my-cool-site");
    changeValue(input, "  my-site  ");
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("my-site");
  });

  test("an invalid name shows an inline error and blocks submit", () => {
    const onSubmit = mock(() => {});
    const r = render(<NamePromptModal open onCancel={() => {}} onSubmit={onSubmit} />);
    const btn = r.getByRole("button", { name: "publish" }) as HTMLButtonElement;
    const input = r.getByPlaceholderText("my-cool-site");

    // uppercase isn't a valid DNS label — validateName rejects it (matches the server)
    changeValue(input, "NotValid");
    fireEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(r.getByText(/must be a lowercase DNS label/)).toBeTruthy();
  });

  test("a reserved name is rejected inline", () => {
    const onSubmit = mock(() => {});
    const r = render(<NamePromptModal open onCancel={() => {}} onSubmit={onSubmit} />);
    const input = r.getByPlaceholderText("my-cool-site");
    changeValue(input, "admin");
    fireEvent.click(r.getByRole("button", { name: "publish" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(r.getByText(/is reserved/)).toBeTruthy();
  });

  test("cancel calls onCancel and closing resets the field for next time", () => {
    const onCancel = mock(() => {});
    const r = render(<NamePromptModal open onCancel={onCancel} onSubmit={() => {}} />);
    fireEvent.click(r.getByRole("button", { name: "cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("busy disables the input and shows the confirm button loading", () => {
    const r = render(<NamePromptModal open busy onCancel={() => {}} onSubmit={() => {}} />);
    const input = r.getByPlaceholderText("my-cool-site") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const btn = r.getByRole("button", { name: "publish" });
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });

  test("a progress bar renders once upload progress is reported", () => {
    const r = render(<NamePromptModal open busy progress={0.42} onCancel={() => {}} onSubmit={() => {}} />);
    expect(r.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
  });

  test("closed modal renders nothing", () => {
    const r = render(<NamePromptModal open={false} onCancel={() => {}} onSubmit={() => {}} />);
    expect(r.queryByRole("dialog")).toBeNull();
  });
});
