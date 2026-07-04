// Managed-postgres detail panels: connection info + lifecycle + password rotation,
// backups, logs.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { CopyField } from "../../components/CopyField.tsx";
import { KV } from "../../components/Field.tsx";
import { RevealOnce } from "../../components/RevealOnce.tsx";
import { PhasePill, Pill } from "../../components/badges.tsx";
import { api, fmtStamp, type Detail } from "../../lib/api.ts";
import { cap, denyReason } from "../../lib/caps.ts";
import { POLL_DETAIL_MS } from "../../lib/query.ts";
import { deriveStatus } from "../../lib/status.ts";
import { LogsPanel } from "./LogsPanel.tsx";
import { ExposurePanel } from "./ExposurePanel.tsx";
import { useWorkloadAction } from "./useWorkloadAction.ts";

export function DbPanels({ d }: { d: Detail }) {
  return (
    <>
      {d.database && <DbInfoPanel d={d} />}
      <ExposurePanel d={d} />
      {/* backups: trigger is `db:create`-gated; list is `read`, so the panel always shows. */}
      {d.database && <BackupsPanel name={d.name} canManage={cap(d, "db:create")} />}
      {/* Logs read behind `logs` (above viewer) — hide rather than 403 on load. */}
      {cap(d, "logs") && <LogsPanel name={d.name} />}
    </>
  );
}

function DbInfoPanel({ d }: { d: Detail }) {
  const db = d.database!;
  const act = useWorkloadAction();
  const canDbOps = cap(d, "db:create"); // hibernate/wake — the DB analog of app deploy
  const canConfigure = cap(d, "configure"); // pooler + password rotate
  // The just-rotated password, shown ONCE via RevealOnce; the API can never return it again.
  const [rotated, setRotated] = useState<{ password: string; warning: string | null } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const rotate = useWorkloadAction({ onSuccess: () => setConfirmRotate(false) });
  const pooler = useWorkloadAction(); // (I3) enable/disable the connection pooler
  const st = db.status ? deriveStatus({ type: "database", status: d.status, dbStatus: db.status }) : null;

  return (
    <div className="sec">
      <h3>managed postgres</h3>
      <KV label="status">
        {db.status && st ? (
          <>
            <Pill s={st} />
            {!st.reason.includes("ready") && (
              <>
                {" "}
                {db.status.ready}/{db.status.instances}
              </>
            )}
          </>
        ) : (
          "—"
        )}
      </KV>
      <KV label="lifecycle">
        {db.status?.hibernated ? (
          <Button size="sm" loading={act.isPending} disabled={!canDbOps} title={canDbOps ? undefined : denyReason("db:create")} onClick={() => act.mutate(() => api.wakeDb(d.name))}>
            wake
          </Button>
        ) : (
          <Button size="sm" variant="danger" loading={act.isPending} disabled={!canDbOps} title={canDbOps ? undefined : denyReason("db:create")} onClick={() => act.mutate(() => api.hibernateDb(d.name))}>
            hibernate
          </Button>
        )}
      </KV>
      <KV label="host">
        <CopyField value={`${db.host}:${db.port}`} />
      </KV>
      <KV label="database">{db.database}</KV>
      <KV label="user">
        <CopyField value={db.user} />
      </KV>
      <KV label="credentials">
        Secret <code>{db.credentialsSecret}</code> · keys <code>username</code>/<code>password</code> (not shown)
      </KV>
      {db.extensions && db.extensions.length > 0 && <KV label="extensions">{db.extensions.join(", ")}</KV>}
      {/* (I3) connection pooler (PgBouncer): toggle + host. Editors can enable/disable. */}
      <KV label="pooler">
        {db.pooler?.enabled ? (
          <>
            <span className="pill pill-ok">on</span> {db.pooler.mode}
            {db.pooler.host && (
              <>
                {" · "}
                <CopyField value={db.pooler.host} />
              </>
            )}
            {" "}
            <Button size="sm" variant="danger" loading={pooler.isPending} disabled={!canConfigure} title={canConfigure ? undefined : denyReason("configure")} onClick={() => pooler.mutate(() => api.setDbPooler(d.name, false))}>
              disable
            </Button>
          </>
        ) : (
          <>
            <span className="sub">off</span>{" "}
            <Button size="sm" loading={pooler.isPending} disabled={!canConfigure} title={canConfigure ? undefined : denyReason("configure")} onClick={() => pooler.mutate(() => api.setDbPooler(d.name, true, "transaction"))}>
              enable (transaction)
            </Button>
          </>
        )}
      </KV>
      <KV label="password">
        {rotated ? (
          <RevealOnce
            value={rotated.password}
            note="shown once — copy it now. restart apps to pick up the new password."
            warning={rotated.warning}
            onDismiss={() => setRotated(null)}
          />
        ) : (
          <>
            <Button size="sm" loading={rotate.isPending} disabled={!canConfigure} title={canConfigure ? undefined : denyReason("configure")} onClick={() => setConfirmRotate(true)}>
              set / rotate password
            </Button>
              <ConfirmDialog
                open={confirmRotate}
                title="Rotate database password"
                body={
                  <>
                    Rotate the database password for <b>{d.name}</b>? The new password is shown once; apps must restart to pick it up.
                  </>
                }
                confirmLabel="rotate password"
                busy={rotate.isPending}
                onCancel={() => setConfirmRotate(false)}
                onConfirm={() =>
                  rotate.mutate(async () => {
                    const r = await api.setDbPassword(d.name);
                    setRotated({ password: r.password, warning: r.warning ?? null });
                  })
                }
              />
            </>
          )}
        </KV>
    </div>
  );
}

/** Managed-database backups: last-success + history, plus an on-demand "back up now". */
function BackupsPanel({ name, canManage }: { name: string; canManage: boolean }) {
  const q = useQuery({
    queryKey: ["/v1/databases", name, "backups"],
    queryFn: () => api.dbBackups(name),
    refetchInterval: POLL_DETAIL_MS,
  });
  const act = useWorkloadAction({ success: "backup started" });
  return (
    <div className="sec">
      <div className="sec-h">
        <h3>backups ({q.data?.backups.length ?? 0})</h3>
        <Button size="sm" loading={act.isPending} disabled={!canManage} title={canManage ? undefined : denyReason("db:create")} onClick={() => act.mutate(() => api.triggerDbBackup(name))}>
          back up now
        </Button>
      </div>
      {q.isError && <div className="err">{q.error.message}</div>}
      <KV label="last success">{fmtStamp(q.data?.lastSuccessAt ?? null)}</KV>
      {q.data?.backups.map((b) => (
        <div className="item" key={b.name}>
          <div className="meta">
            <b>{b.name}</b>
            <div className="sub">
              <PhasePill phase={b.phase} /> {fmtStamp(b.startedAt)}
              {b.error ? ` · ${b.error}` : ""}
            </div>
          </div>
        </div>
      ))}
      {q.data && !q.data.backups.length && <p className="muted">no backups yet — runs daily + on-demand</p>}
    </div>
  );
}
