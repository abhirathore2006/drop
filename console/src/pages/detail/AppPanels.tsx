// App detail panels: container info + lifecycle, write-only secrets, logs.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { Field, KV } from "../../components/Field.tsx";
import { Pill } from "../../components/badges.tsx";
import { api, fmtStamp, type Detail } from "../../lib/api.ts";
import { cap, denyReason } from "../../lib/caps.ts";
import { deriveStatus } from "../../lib/status.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { LogsPanel } from "./LogsPanel.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { ExposurePanel } from "./ExposurePanel.tsx";
import { useWorkloadAction } from "./useWorkloadAction.ts";

export function AppPanels({ d }: { d: Detail }) {
  return (
    <>
      {d.app && <AppInfoPanel d={d} />}
      <ExposurePanel d={d} />
      {/* (E2) App previews (`drop deploy --preview`) — parallel scale-0/1 workloads at <name>--<label>. */}
      <AppPreviewsPanel d={d} />
      {/* Secrets list reads behind `configure` (server-gated) — hide the whole surface without it. */}
      {cap(d, "configure") && <SecretsPanel name={d.name} />}
      {/* (L4) Runtime config — a NON-SECRET KV shown in plaintext (distinct from the write-only secrets
          panel above). Same `configure` gate (mutations are configure-gated server-side). */}
      {cap(d, "configure") && <ConfigPanel name={d.name} />}
      {/* (M3/J3) Interactive shell — gated on `exec` (editor+). A shell can read the app's env, so the
          panel carries a one-time-per-app secrets ack before the first session. */}
      {cap(d, "exec") && <TerminalPanel d={d} />}
      {/* Logs read behind `logs` (above viewer) — hide rather than 403 on load. */}
      {cap(d, "logs") && <LogsPanel name={d.name} type="app" />}
    </>
  );
}

// (E2) Active app previews (label, URL, expiry, an "own db" badge) with a remove button. Mirrors the
// E1 SitePanels previews list. Previews are created via `drop deploy --preview` / CI (docs/previews.html);
// removing one is `deploy`-gated (the same verb that created it) and tears down the parallel workload.
function AppPreviewsPanel({ d }: { d: Detail }) {
  const previews = d.previews ?? [];
  const canManage = cap(d, "deploy"); // removing a preview is `deploy`-gated (same as creating one)
  const rm = useWorkloadAction({ success: "preview removed" });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  if (previews.length === 0) return null; // nothing to show — keep the panel list uncluttered
  return (
    <div className="sec">
      <h3>previews ({previews.length})</h3>
      {previews.map((p) => (
        <div className="item" key={p.label}>
          <div className="meta">
            <b>{p.label}</b>
            <div className="sub">
              <a href={p.url} target="_blank" rel="noreferrer">
                {p.url.replace(/^https?:\/\//, "")}
              </a>
              {" · expires "}
              {fmtStamp(p.expiresAt)}
              {/* (L2) a --from-backup branch shows its provenance; an empty --with-db clone shows "own db". */}
              {p.branchedFrom ? ` · branched from ${p.branchedFrom}${p.branchedAt ? `@${fmtStamp(p.branchedAt)}` : ""}` : p.hasDb && " · own db"}
            </div>
          </div>
          {canManage && (
            <Button size="sm" variant="danger" loading={rm.isPending} onClick={() => setConfirmRemove(p.label)}>
              remove
            </Button>
          )}
        </div>
      ))}
      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove preview ${confirmRemove ?? ""}`}
        body={
          <>
            Remove the preview <b>{confirmRemove}</b> on <b>{d.name}</b>? Its workload
            {previews.find((p) => p.label === confirmRemove)?.hasDb ? " and its --with-db clone" : ""} are torn down and its URL stops resolving immediately.
          </>
        }
        confirmLabel="remove"
        danger
        busy={rm.isPending}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => rm.mutate(() => api.removePreview(d.name, confirmRemove!), { onSuccess: () => setConfirmRemove(null) })}
      />
    </div>
  );
}

function AppInfoPanel({ d }: { d: Detail }) {
  const app = d.app!;
  const act = useWorkloadAction();
  const canDeploy = cap(d, "deploy");
  const st = app.status
    ? deriveStatus({ type: "app", status: d.status, runtimeState: app.runtimeState, appStatus: app.status })
    : null;
  // (I5) `stateful` isn't on the typed `app` detail shape (console/lib/api.ts is coordinated elsewhere
  // this slice) — the server already returns it for free on `versions[].config` (the raw stored
  // AppConfig, verbatim), so read it from there defensively instead of widening the Detail/Version
  // types here. Absent for every non-stateful app (the common case).
  const stateful = (d.versions.find((v) => v.id === d.current) as { config?: { stateful?: { volume: string; mount: string } } } | undefined)?.config
    ?.stateful;
  return (
    <div className="sec">
      <h3>container app</h3>
      <KV label="image">{app.image ?? "—"}</KV>
      <KV label="scale">{app.scale ? `min ${app.scale.min} · max ${app.scale.max}` : "—"}</KV>
      <KV label="resources">{app.resources ? `${app.resources.cpu ?? "—"} cpu · ${app.resources.memory ?? "—"}` : "—"}</KV>
      {stateful && (
        <KV label="stateful volume">
          {stateful.volume} at {stateful.mount} — always-on, single replica (no snapshots v1; delete requires --force)
        </KV>
      )}
      <KV label="status">
        {app.status && st ? (
          <>
            <Pill s={st} />
            {!st.reason.includes("ready") && (
              <>
                {" "}
                {app.status.ready}/{app.status.replicas} ready
              </>
            )}
            {app.status.restarts > 0 && <span className="restarts"> · {app.status.restarts} restarts</span>}
          </>
        ) : (
          "—"
        )}
      </KV>
      {/* Lifecycle is `deploy`-gated: the buttons stay visible but DISABLED with a tooltip when the
          actor can't deploy (M2 convention for role-gated actions). */}
      <KV label="lifecycle">
        <Button size="sm" loading={act.isPending} disabled={!canDeploy} title={canDeploy ? undefined : denyReason("deploy")} onClick={() => act.mutate(() => api.restartApp(d.name))}>
          restart
        </Button>{" "}
        {app.runtimeState === "stopped" ? (
          <Button size="sm" loading={act.isPending} disabled={!canDeploy} title={canDeploy ? undefined : denyReason("deploy")} onClick={() => act.mutate(() => api.startApp(d.name))}>
            start
          </Button>
        ) : (
          <Button size="sm" variant="danger" loading={act.isPending} disabled={!canDeploy} title={canDeploy ? undefined : denyReason("deploy")} onClick={() => act.mutate(() => api.stopApp(d.name))}>
            stop
          </Button>
        )}
      </KV>
      {/* (M3) The exec terminal lives in its own panel below (TerminalPanel, gated on cap(d,"exec")) —
          it carries the shared StreamHeader + secrets ack, so it isn't crammed into this info row. */}
    </div>
  );
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Write-only secrets: list KEY names (values are never shown), add/update, delete. Only rendered
 *  when the actor holds `configure` (the list endpoint itself is configure-gated), so every control
 *  here is unconditionally available. */
function SecretsPanel({ name }: { name: string }) {
  const q = useQuery({ queryKey: ["/v1/apps", name, "secrets"], queryFn: () => api.listSecrets(name) });
  const act = useWorkloadAction();
  const [nk, setNk] = useState("");
  const [nv, setNv] = useState("");
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const keys = q.data?.secrets;

  const add = () => {
    if (!nk || !nv) return;
    if (!KEY_RE.test(nk)) {
      setKeyErr("keys are UPPER_SNAKE_CASE (A-Z, 0-9, _)");
      return;
    }
    setKeyErr(null);
    act.mutate(async () => {
      await api.setSecret(name, nk, nv);
      setNk("");
      setNv("");
    });
  };

  return (
    <div className="sec">
      <h3>secrets ({keys?.length ?? 0})</h3>
      {q.isError && <div className="err">{q.error.message}</div>}
      {keys?.length === 0 && <p className="muted">no secrets — injected as env vars, write-only</p>}
      {keys?.map((k) => (
        <div className="item" key={k.key}>
          <div className="meta">
            <b>{k.key}</b>
            <div className="sub">
              •••••• · {k.updatedBy} · {new Date(k.updatedAt).toISOString().slice(0, 10)}
            </div>
          </div>
          <Button size="sm" variant="danger" disabled={act.isPending} title="delete" onClick={() => act.mutate(() => api.deleteSecret(name, k.key))}>
            ✕
          </Button>
        </div>
      ))}
      <Field error={keyErr}>
        <form
          className="secadd"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            placeholder="KEY"
            value={nk}
            onChange={(e) => {
              setNk(e.target.value.toUpperCase());
              if (keyErr) setKeyErr(null);
            }}
          />
          <input placeholder="value (write-only)" type="password" value={nv} onChange={(e) => setNv(e.target.value)} />
          <Button size="sm" type="submit" disabled={!nk || !nv} loading={act.isPending}>
            set
          </Button>
        </form>
      </Field>
      {!!keys?.length && (
        <div className="sub">
          set/changed secrets apply on the next <b>restart</b>.
        </div>
      )}
    </div>
  );
}

const CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;

/** (L4) Runtime config: a per-app NON-SECRET key/value table. Unlike secrets, values are returned and
 *  shown in PLAINTEXT (the server refuses credential-looking values). Inline add/edit/remove. Only
 *  rendered when the actor holds `configure` (mutations are configure-gated), so every control is
 *  unconditionally available here. Exported for the panel's own smoke test. */
export function ConfigPanel({ name }: { name: string }) {
  const q = useQuery({ queryKey: ["/v1/apps", name, "config"], queryFn: () => api.listConfig(name) });
  const act = useWorkloadAction();
  const [nk, setNk] = useState("");
  const [nv, setNv] = useState("");
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const entries = q.data ? Object.entries(q.data.config) : [];

  const add = () => {
    if (!nk || !nv) return;
    if (!CONFIG_KEY_RE.test(nk)) {
      setKeyErr("keys are env-var-ish (letter/underscore start, then letters, digits, _ or .)");
      return;
    }
    setKeyErr(null);
    act.mutate(async () => {
      await api.setConfig(name, nk, nv);
      setNk("");
      setNv("");
    });
  };

  return (
    <div className="sec">
      <h3>config ({entries.length})</h3>
      {q.isError && <div className="err">{q.error.message}</div>}
      <div className="sub">
        runtime key/value — <b>non-secret</b>, shown in plaintext and polled by the app (no restart). Put credentials in the secrets panel above.
      </div>
      {entries.length === 0 && <p className="muted">no config — add a key below</p>}
      {entries.map(([k, v]) => (
        <ConfigRow key={k} name={name} k={k} v={v} act={act} />
      ))}
      <Field error={keyErr}>
        <form
          className="secadd"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            aria-label="new config key"
            placeholder="KEY"
            value={nk}
            onChange={(e) => {
              setNk(e.target.value);
              if (keyErr) setKeyErr(null);
            }}
          />
          <input aria-label="new config value" placeholder="value" value={nv} onChange={(e) => setNv(e.target.value)} />
          <Button size="sm" type="submit" disabled={!nk || !nv} loading={act.isPending}>
            set
          </Button>
        </form>
      </Field>
    </div>
  );
}

/** One config row: KEY + an inline-editable value (saves on Enter/blur when changed) + remove. Keyed by
 *  the config key upstream, so a value edit re-renders this same instance and the local input persists. */
function ConfigRow({ name, k, v, act }: { name: string; k: string; v: string; act: ReturnType<typeof useWorkloadAction> }) {
  const [val, setVal] = useState(v);
  const save = () => {
    if (val !== v) act.mutate(() => api.setConfig(name, k, val));
  };
  return (
    <div className="item">
      <div className="meta">
        <b>{k}</b>
        <form
          className="secadd"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input aria-label={`value for ${k}`} value={val} onChange={(e) => setVal(e.target.value)} onBlur={save} />
        </form>
      </div>
      <Button size="sm" variant="danger" disabled={act.isPending} aria-label={`remove ${k}`} title="delete" onClick={() => act.mutate(() => api.deleteConfig(name, k))}>
        ✕
      </Button>
    </div>
  );
}
