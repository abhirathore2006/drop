import { useState } from "react";
import { Button } from "./Button.tsx";
import { copyText } from "./CopyField.tsx";

export interface RevealOnceProps {
  /** The show-once secret. The caller must not be able to refetch it. */
  value: string;
  /** Context line under the secret, e.g. "shown once — copy it now." */
  note?: string;
  /** Optional warning (e.g. partial rotation) rendered in the warn style. */
  warning?: string | null;
  /** Called when the user explicitly confirms they saved it; the parent should drop the value. */
  onDismiss?: () => void;
}

/** Show-once secret display: the value is visible until the user explicitly clicks
 *  "I saved it" — no auto-hide, no way to bring it back afterwards (never-refetchable
 *  semantics live with the caller; this component enforces the explicit dismissal). */
export function RevealOnce({ value, note, warning, onDismiss }: RevealOnceProps) {
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (dismissed) return <span className="sub">saved — not shown again</span>;

  return (
    <span className="reveal-once">
      <code className="reveal">{value}</code>
      {note && <div className="sub">{note}</div>}
      {warning && <div className="warn">⚠ {warning}</div>}
      <div className="reveal-actions">
        <Button
          size="sm"
          onClick={async () => {
            if (await copyText(value)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? "copied ✓" : "copy"}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setDismissed(true);
            onDismiss?.();
          }}
        >
          I saved it
        </Button>
      </div>
    </span>
  );
}
