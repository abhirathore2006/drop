import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "danger";
  size?: "md" | "sm";
  loading?: boolean;
  wide?: boolean;
  children: ReactNode;
}

/** The one button. `loading` disables it and shows a spinner beside the label. */
export function Button({ variant = "default", size = "md", loading = false, wide = false, disabled, children, className, ...rest }: ButtonProps) {
  const cls = [
    "btn",
    size === "sm" ? "sm" : "",
    variant !== "default" ? variant : "",
    wide ? "wide" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
