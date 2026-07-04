import { useId, useState, type ReactNode } from "react";
import { Button } from "./Button.tsx";

/** Key/value display row (detail panels). */
export function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <div className="k">{label}</div>
      <div className="v">{children}</div>
    </div>
  );
}

/** Form field wrapper with inline validation error. When `errorId` is supplied the error node
 *  carries that id so the control can point `aria-describedby` at it; the error is a `role=alert`
 *  live region so it's announced the moment it appears (M5 a11y). */
export function Field({ error, errorId, children }: { error?: string | null; errorId?: string; children: ReactNode }) {
  return (
    <div className="field">
      {children}
      {error && (
        <div className="field-err" id={errorId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export interface AddRowProps {
  placeholder: string;
  cta: string;
  /** Inline validation: return an error string to block submission, null to allow. */
  validate?: (value: string) => string | null;
  busy?: boolean;
  onSubmit: (value: string) => void;
}

/** Single input + button row (share, transfer). Validation errors render inline. */
export function AddRow({ placeholder, cta, validate, busy = false, onSubmit }: AddRowProps) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const errId = useId();
  const submit = () => {
    const val = v.trim();
    if (!val) return;
    const e = validate?.(val) ?? null;
    setErr(e);
    if (e) return;
    onSubmit(val);
    setV("");
  };
  return (
    <Field error={err} errorId={errId}>
      <form
        className="addrow"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={v}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? errId : undefined}
          onChange={(e) => {
            setV(e.target.value);
            if (err) setErr(null);
          }}
        />
        <Button size="sm" type="submit" disabled={!v.trim()} loading={busy}>
          {cta}
        </Button>
      </form>
    </Field>
  );
}

export const validateEmail = (v: string): string | null => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "enter a valid email address");
