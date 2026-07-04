// Managed cache (Valkey) detail panel: connection info (host/port), memory + persistence badges,
// live status, and a LOUD ephemerality warning when the cache is not persistent. The password is
// never surfaced — it's revealed once at create (inside REDIS_URL) and bound to apps automatically
// via `uses: [{ cache: <name> }]`. Delete lives in the shared danger zone.
import { CopyField } from "../../components/CopyField.tsx";
import { KV } from "../../components/Field.tsx";
import { Pill } from "../../components/badges.tsx";
import { type Detail } from "../../lib/api.ts";
import { deriveStatus } from "../../lib/status.ts";

export function CachePanels({ d }: { d: Detail }) {
  const c = d.cache;
  const st = c ? deriveStatus({ type: "cache", status: d.status, cacheStatus: c.status }) : null;
  return (
    <div className="sec">
      <h3>managed cache (valkey)</h3>
      {c ? (
        <>
          <KV label="status">{st ? <Pill s={st} /> : "—"}</KV>
          <KV label="host">
            <CopyField value={`${c.host}:${c.port}`} />
          </KV>
          <KV label="memory">{c.memory}</KV>
          <KV label="persistence">
            {c.persistent ? (
              <span className="pill pill-ok">persistent</span>
            ) : (
              <span className="pill pill-warn">ephemeral</span>
            )}
          </KV>
          {!c.persistent && (
            <p className="muted" style={{ marginTop: 6 }}>
              ⚠ EPHEMERAL — a restart (redeploy, node move, crash) loses ALL data. Use only for a cache you can rebuild; for
              durable data recreate with <code>--persistent</code>.
            </p>
          )}
          <KV label="connection">
            Bind an app with <code>uses: [{"{ cache: " + d.name + " }"}]</code> to inject <code>REDIS_URL</code> (password included).
          </KV>
        </>
      ) : (
        <KV label="cache">
          <span className="sub">unavailable</span>
        </KV>
      )}
    </div>
  );
}
