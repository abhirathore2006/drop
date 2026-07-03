import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Modal } from "./Modal.tsx";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  /** When set, the confirm button stays disabled until the user types this exact string
   *  (type-the-name gating for destructive actions — replaces native confirm()/prompt()). */
  typeToConfirm?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, body, confirmLabel, danger = false, busy = false, typeToConfirm, onConfirm, onCancel }: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped(""); // reset between uses
  }, [open]);

  const gated = typeToConfirm !== undefined && typed !== typeToConfirm;

  return (
    <Modal open={open} title={title} onClose={onCancel}>
      {body !== undefined && <div className="modal-body">{body}</div>}
      {typeToConfirm !== undefined && (
        <label className="modal-body" style={{ display: "block" }}>
          Type <code>{typeToConfirm}</code> to confirm
          <input
            className="confirm-name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={typeToConfirm}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
      <div className="modal-actions">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          cancel
        </Button>
        <Button size="sm" variant={danger ? "danger" : "primary"} disabled={gated} loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
