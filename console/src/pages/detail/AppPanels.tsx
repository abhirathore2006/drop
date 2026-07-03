// App detail panels: container info + lifecycle, write-only secrets, logs.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { Field, KV } from "../../components/Field.tsx";
import { Pill } from "../../components/badges.tsx";
import { api, type Detail } from "../../lib/api.ts";
import { deriveStatus } from "../../lib/status.ts";
import { LogsPanel } from "./LogsPanel.tsx";
import { useWorkloadAction } from "./useWorkloadAction.ts";

export function AppPanels({ d, isOwner, canDeploy }: { d: Detail; isOwner: boolean; canDeploy: boolean }) {
  return (
    <>
      {d.app && <AppInfoPanel d={d} canDeploy={canDeploy} />}
      <SecretsPanel name={d.name} canManage={isOwner} />
      <LogsPanel name={d.name} />
    </>
  );
}

function AppInfoPanel({ d, canDeploy }: { d: Detail; canDeploy: boolean }) {
  const app = d.app!;
  const act = useWorkloadAction();
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
      {canDeploy && (
        <KV label="lifecycle">
          <Button size="sm" loading={act.isPending} onClick={() => act.mutate(() => api.restartApp(d.name))}>
            restart
          </Button>{" "}
          {app.runtimeState === "stopped" ? (
            <Button size="sm" loading={act.isPending} onClick={() => act.mutate(() => api.startApp(d.name))}>
              start
            </Button>
          ) : (
            <Button size="sm" variant="danger" loading={act.isPending} onClick={() => act.mutate(() => api.stopApp(d.name))}>
              stop
            </Button>
          )}
        </KV>
      )}
    </div>
  );
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Write-only secrets: list KEY names (values are never shown), add/update, delete. */
function SecretsPanel({ name, canManage }: { name: string; canManage: boolean }) {
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
          {canManage && (
            <Button size="sm" variant="danger" disabled={act.isPending} title="delete" onClick={() => act.mutate(() => api.deleteSecret(name, k.key))}>
              ✕
            </Button>
          )}
        </div>
      ))}
      {canManage && (
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
      )}
      {canManage && !!keys?.length && (
        <div className="sub">
          set/changed secrets apply on the next <b>restart</b>.
        </div>
      )}
    </div>
  );
}
