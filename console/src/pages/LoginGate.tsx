import { useEffect } from "react";
import { rememberLocation } from "../lib/query.ts";

/** Signed-out (or session-expired) gate. Mounting remembers the current location so a
 *  successful sign-in returns the user to where they were (App consumes it on boot). */
export function LoginGate({ expired = false }: { expired?: boolean }) {
  useEffect(() => {
    rememberLocation();
  }, []);
  return (
    <div className="gate">
      <div className="brand">
        <span className="tri">▸</span> drop
      </div>
      <p>{expired ? "Your session expired — sign in again to continue where you left off." : "Sign in to manage your sites, apps, and databases."}</p>
      <a className="btn primary" href="/login">
        Sign in with Google →
      </a>
    </div>
  );
}
