import { useEffect, useState } from "react";
import { rememberLocation } from "../lib/query.ts";

/** Public login metadata (J2). `displayName` is the SSO provider label (Google / Okta / Entra ID / …);
 *  `breakGlass` says whether the emergency local-admin login is enabled on this deployment. */
interface AuthMeta {
  displayName: string;
  breakGlass: boolean;
}

/** Signed-out (or session-expired) gate. Mounting remembers the current location so a
 *  successful sign-in returns the user to where they were (App consumes it on boot). The
 *  provider label is fetched from /v1/auth/meta so the button isn't hard-wired to "Google". */
export function LoginGate({ expired = false }: { expired?: boolean }) {
  const [meta, setMeta] = useState<AuthMeta | null>(null);
  useEffect(() => {
    rememberLocation();
    let cancelled = false;
    fetch("/v1/auth/meta")
      .then((r) => (r.ok ? (r.json() as Promise<AuthMeta>) : null))
      .then((m) => {
        if (!cancelled && m) setMeta(m);
      })
      .catch(() => {
        /* fall back to the generic label */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="gate">
      <div className="brand">
        <span className="tri">▸</span> drop
      </div>
      <p>{expired ? "Your session expired — sign in again to continue where you left off." : "Sign in to manage your sites, apps, and databases."}</p>
      <a className="btn primary" href="/login">
        {meta ? `Sign in with ${meta.displayName} →` : "Sign in →"}
      </a>
      {meta?.breakGlass && (
        <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          <a href="/auth/break-glass">Break-glass sign in</a>
        </p>
      )}
    </div>
  );
}
