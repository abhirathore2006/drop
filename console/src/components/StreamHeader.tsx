import type { ReactNode } from "react";

// The connection-state header shared by all three M3 streaming surfaces (live logs, exec terminal, SQL
// console): a title, a live/reconnecting/closed pill, and an optional cluster of actions on the right.
// One header keeps the three surfaces reading the same way and gives the session-expiry / reconnect
// states a single visual vocabulary.

/** The stream lifecycle a surface can be in. SQL (request/response, not a socket) reuses `idle`/`live`
 *  with a custom `label` ("ready" / "running"). */
export type StreamState = "connecting" | "live" | "reconnecting" | "closed" | "idle";

const PILL: Record<StreamState, string> = {
  connecting: "pill-progress",
  live: "pill-ok",
  reconnecting: "pill-warn",
  closed: "pill-idle",
  idle: "pill-idle",
};

export interface StreamHeaderProps {
  title: ReactNode;
  state: StreamState;
  /** Overrides the default state text (the enum name) — e.g. SQL shows "ready" / "running". */
  label?: string;
  /** Right-aligned controls (toggles, download, run, reconnect …). */
  actions?: ReactNode;
}

export function StreamHeader({ title, state, label, actions }: StreamHeaderProps) {
  const live = state === "live" || state === "connecting";
  return (
    <div className="sec-h stream-h">
      <div className="stream-h-title">
        <h3>{title}</h3>
        <span className={`pill ${PILL[state]} stream-pill`} role="status" aria-live="polite">
          <span className={`stream-dot${live ? " live" : ""}`} aria-hidden="true" />
          {label ?? state}
        </span>
      </div>
      {actions !== undefined && <div className="stream-h-actions">{actions}</div>}
    </div>
  );
}
