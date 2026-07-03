import { useState } from "react";

/** Copy text to the clipboard; falls back to a hidden textarea when the async clipboard
 *  API is unavailable (http origins, older engines). Returns success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface CopyFieldProps {
  value: string;
  /** Rendered instead of the value (e.g. a masked secret) — the copy still copies `value`. */
  display?: string;
}

/** Inline monospace value with a copy affordance. */
export function CopyField({ value, display }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copyfield">
      <code>{display ?? value}</code>
      <button
        className="btn sm"
        type="button"
        onClick={async () => {
          if (await copyText(value)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        {copied ? "copied ✓" : "copy"}
      </button>
    </span>
  );
}
