// Prompts for a new site's name after a folder drop on the workloads list page — the
// browser equivalent of `drop publish ./dist myname`. Validated with lib/validateName.ts
// (a mirror of the server's src/names.ts validateName, lock-step tested against it — see
// that file's header comment for why it's a mirror and not a direct import) so client-side
// errors match what the server would reject.
import { useEffect, useState } from "react";
import { validateName } from "../lib/validateName.ts";
import { Button } from "./Button.tsx";
import { Field } from "./Field.tsx";
import { Modal } from "./Modal.tsx";

export interface NamePromptModalProps {
  open: boolean;
  /** Upload in flight — disables the input and shows the confirm button as busy. */
  busy?: boolean;
  /** 0..1 upload progress, shown once the name is confirmed and the publish starts. */
  progress?: number | null;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}

export function NamePromptModal({ open, busy = false, progress = null, onCancel, onSubmit }: NamePromptModalProps) {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setTouched(false);
    }
  }, [open]);

  const error = touched ? validateName(name.trim()) : null;

  const submit = () => {
    setTouched(true);
    if (validateName(name.trim())) return;
    onSubmit(name.trim());
  };

  return (
    <Modal open={open} title="Publish a new site" onClose={onCancel}>
      <div className="modal-body">Choose a name — it becomes part of the site's live URL.</div>
      <Field error={error}>
        <input
          autoFocus
          value={name}
          placeholder="my-cool-site"
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            if (touched) setTouched(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </Field>
      {progress != null && (
        <div className="drop-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div className="modal-actions">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          cancel
        </Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>
          publish
        </Button>
      </div>
    </Modal>
  );
}
