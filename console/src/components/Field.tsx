import { useState, type ReactNode } from "react";
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

/** Form field wrapper with inline validation error. */
export function Field({ error, children }: { error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      {children}
      {error && <div className="field-err">{error}</div>}
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
    <Field error={err}>
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
