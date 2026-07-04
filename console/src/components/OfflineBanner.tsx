// Global "the API is unreachable" banner (M5 resilience). The query layer (lib/query.ts) flips
// networkStatus after a run of transport failures — a dropped Wi-Fi, a bounced API, a paused
// laptop. While offline this banner pins to the top and actively re-probes /version every few
// seconds so recovery is snappy (a normal query success also clears it). It hides itself the
// instant the probe (or any query) reaches the server again.
import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import { networkStatus } from "../lib/query.ts";

const PING_MS = 5000;

export function OfflineBanner() {
  const offline = useSyncExternalStore(networkStatus.subscribe, networkStatus.getSnapshot, networkStatus.getSnapshot);

  useEffect(() => {
    if (!offline) return;
    let stop = false;
    const ping = async () => {
      try {
        // Cache-busting, credentialless liveness probe. Any reachable response (even a 4xx) proves
        // the API is up — only a thrown TypeError means still-unreachable, so we keep pinging.
        const res = await fetch(`/version?_=${Date.now()}`, { cache: "no-store" });
        if (!stop && res) networkStatus.set(false);
      } catch {
        /* still unreachable — the interval tries again */
      }
    };
    const id = setInterval(ping, PING_MS);
    void ping();
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [offline]);

  if (!offline) return null;
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className="offline-dot" aria-hidden="true" />
      Can&rsquo;t reach Drop — retrying…
    </div>
  );
}
