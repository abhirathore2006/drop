// Managed-postgres detail panels: connection info + lifecycle + password rotation,
// backups, logs.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { CopyField } from "../../components/CopyField.tsx";
import { KV } from "../../components/Field.tsx";
import { RevealOnce } from "../../components/RevealOnce.tsx";
import { Table } from "../../components/Table.tsx";
import { PhasePill, Pill } from "../../components/badges.tsx";
import { api, fmtStamp, type Detail, type SqlQueryResult } from "../../lib/api.ts";
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
      {/* (I4) SQL console — gated on the `query` capability (editor+; hidden for a metadata-only viewer). */}
      {d.database && cap(d, "query") && <SqlConsolePanel name={d.name} />}
      <ExposurePanel d={d} />
      {/* backups: trigger is `db:create`-gated; list is `read`, so the panel always shows. */}
      {d.database && <BackupsPanel name={d.name} canManage={cap(d, "db:create")} />}
      {/* Logs read behind `logs` (above viewer) — hide rather than 403 on load. */}
      {cap(d, "logs") && <LogsPanel name={d.name} />}
    </>
  );
}

/** (I4) Read-only SQL console: a plain textarea (no Monaco/CodeMirror v1), a Run button (⌘/Ctrl+Enter),
 *  and results in the shared Table primitive. A PERMANENT banner states the guarantees up front
 *  (read-only · audited · 5s timeout · 500 rows); errors show inline. Writes are refused at the engine —
 *  the panel makes no attempt to allow them (no `--unsafe-write`; use `drop db proxy` for writes). */
function SqlConsolePanel({ name }: { name: string }) {
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    const q = sql.trim();
    if (!q || running) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await api.dbQuery(name, q));
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
    }
  };

  const cell = (v: unknown) => (v === null || v === undefined ? <span className="muted">null</span> : typeof v === "object" ? JSON.stringify(v) : String(v));
  const columns = result
    ? result.columns.map((col, i) => ({ key: String(i), header: col.name, render: (row: { i: number; cells: unknown[] }) => cell(row.cells[i]) }))
    : [];
  const rows = result ? result.rows.map((cells, i) => ({ i, cells })) : [];

  return (
    <div className="sec">
      <h3>SQL console</h3>
      {/* PERMANENT banner — the guarantees are stated up front, not just on hover. */}
      <div className="sub" style={{ marginBottom: 8 }}>read-only · audited · 5s timeout · 500 rows</div>
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="select * from … limit 100"
        rows={4}
        spellCheck={false}
        aria-label="SQL query"
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "ui-monospace, monospace",
          fontSize: 12.5,
          lineHeight: 1.5,
          padding: 10,
          borderRadius: 8,
          border: "1px solid var(--border-strong)",
          background: "var(--surface)",
          color: "inherit",
          resize: "vertical",
        }}
      />
      <div style={{ marginTop: 8 }}>
        <Button size="sm" loading={running} disabled={!sql.trim()} onClick={() => void run()}>
          Run (⌘/Ctrl+Enter)
        </Button>
      </div>
      {error && (
        <div className="err" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
      {result && (
        <div style={{ marginTop: 10 }}>
          <div style={{ overflowX: "auto" }}>
            <Table columns={columns} rows={rows} rowKey={(row) => String(row.i)} empty="no rows" />
          </div>
          <div className="sub" style={{ marginTop: 6 }}>
            {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
            {result.truncated ? " · truncated at 500" : ""} · {result.elapsedMs}ms
          </div>
        </div>
      )}
    </div>
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
