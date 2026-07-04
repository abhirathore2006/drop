// App detail panels: container info + lifecycle, write-only secrets, logs.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { Field, KV } from "../../components/Field.tsx";
import { Pill } from "../../components/badges.tsx";
import { api, type Detail } from "../../lib/api.ts";
import { cap, denyReason } from "../../lib/caps.ts";
import { deriveStatus } from "../../lib/status.ts";
import { LogsPanel } from "./LogsPanel.tsx";
import { ExposurePanel } from "./ExposurePanel.tsx";
import { useWorkloadAction } from "./useWorkloadAction.ts";

export function AppPanels({ d }: { d: Detail }) {
  return (
    <>
      {d.app && <AppInfoPanel d={d} />}
      <ExposurePanel d={d} />
      {/* Secrets list reads behind `configure` (server-gated) — hide the whole surface without it. */}
      {cap(d, "configure") && <SecretsPanel name={d.name} />}
      {/* Logs read behind `logs` (above viewer) — hide rather than 403 on load. */}
      {cap(d, "logs") && <LogsPanel name={d.name} />}
    </>
  );
}

function AppInfoPanel({ d }: { d: Detail }) {
  const app = d.app!;
  const act = useWorkloadAction();
  const canDeploy = cap(d, "deploy");
  const st = app.status
    ? deriveStatus({ type: "app", status: d.status, runtimeState: app.runtimeState, appStatus: app.status })
    : null;
  return (
    <div className="sec">
      <h3>container app</h3>
      <KV label="image">{app.image ?? "—"}</KV>
      <KV label="scale">{app.scale ? `min ${app.scale.min} · max ${app.scale.max}` : "—"}</KV>
      <KV label="resources">{app.resources ? `${app.resources.cpu ?? "—"} cpu · ${app.resources.memory ?? "—"}` : "—"}</KV>
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
      {/* M3: an "open shell" button goes HERE — gated on cap(d, "exec") (the J3 verb), it opens the
          xterm.js terminal panel that bridges to `GET /v1/apps/:name/exec` over a WebSocket. The API
          + CLI transport already exist (J3); only the browser terminal UI is deferred to M3. */}
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
