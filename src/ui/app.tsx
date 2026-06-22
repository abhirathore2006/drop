import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Detail, type ListItem, type Me, type WorkloadType } from "./api.ts";

const TYPE_LABEL: Record<WorkloadType, string> = { site: "SITE", app: "APP", database: "DB" };

function TypeBadge({ t }: { t: WorkloadType }) {
  return <span className={`badge badge-${t}`}>{TYPE_LABEL[t]}</span>;
}

function StatusPill({ reason }: { reason: string }) {
  const danger = /CrashLoopBackOff|Error|Failed|ImagePull|Pending/i.test(reason);
  const idle = /ScaledToZero|NoPods|hibernat/i.test(reason);
  const cls = danger ? "pill pill-danger" : idle ? "pill pill-idle" : "pill pill-ok";
  return <span className={cls}>{reason}</span>;
}

function Card({ w, onOpen }: { w: ListItem; onOpen: () => void }) {
  return (
    <button className="card" onClick={onOpen}>
      <div className="card-top">
        <span className="dot" />
        <span className="card-name">{w.name}</span>
        <TypeBadge t={w.type} />
      </div>
      <div className="card-owner">{w.owner}</div>
      <div className="card-foot">
        <span className="ver">{w.current ? "#" + w.current.replace(/^v_\d+_/, "") : "—"}</span>
      </div>
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <div className="k">{label}</div>
      <div className="v">{children}</div>
    </div>
  );
}

function Logs({ name }: { name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setText((await api.logs(name)).logs || "(no logs)");
    } catch (e) {
      setText("error: " + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="sec">
      <div className="sec-h">
        <h3>logs</h3>
        <button className="btn sm" onClick={load} disabled={loading}>
          {loading ? "…" : text === null ? "load" : "refresh"}
        </button>
      </div>
      {text !== null && <pre className="logs">{text}</pre>}
    </div>
  );
}

// Write-only secrets panel: list KEY names (values are never shown), add/update (write-only), delete.
function Secrets({ name, canManage, onChanged }: { name: string; canManage: boolean; onChanged: () => void }) {
  const [keys, setKeys] = useState<{ key: string; fingerprint: string; updatedBy: string; updatedAt: string }[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [nk, setNk] = useState("");
  const [nv, setNv] = useState("");
  const load = useCallback(async () => {
    try {
      setKeys((await api.listSecrets(name)).secrets);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sec">
      <h3>secrets ({keys?.length ?? 0})</h3>
      {err && <div className="err">{err}</div>}
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
            <button className="btn sm danger" disabled={busy} title="delete" onClick={() => run(() => api.deleteSecret(name, k.key))}>
              ✕
            </button>
          )}
        </div>
      ))}
      {canManage && (
        <form
          className="secadd"
          onSubmit={(e) => {
            e.preventDefault();
            if (nk && nv)
              void run(async () => {
                await api.setSecret(name, nk, nv);
                setNk("");
                setNv("");
              });
          }}
        >
          <input placeholder="KEY" value={nk} onChange={(e) => setNk(e.target.value.toUpperCase())} />
          <input placeholder="value (write-only)" type="password" value={nv} onChange={(e) => setNv(e.target.value)} />
          <button className="btn sm" disabled={busy || !nk || !nv}>
            set
          </button>
        </form>
      )}
      {canManage && !!keys?.length && <div className="sub">set/changed secrets apply on the next <b>restart</b>.</div>}
    </div>
  );
}

function Drawer({ name, me, onClose, onChanged }: { name: string; me: Me; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState<string | null>(null); // the just-rotated DB password, shown once
  const [pwWarn, setPwWarn] = useState<string | null>(null); // partial-rotation warning (Secret didn't sync)

  const load = useCallback(async () => {
    try {
      setD(await api.get(name));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, closeAfter = false) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onChanged();
      if (closeAfter) onClose();
      else await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const isOwner = d?.owner === me.email || me.admin;
  // lifecycle (restart/stop/start) is editor+; secrets are owner/admin.
  const canDeploy = !!me.admin || !!d?.members.some((m) => m.email === me.email && (m.role === "owner" || m.role === "editor"));

  const rotatePw = async () => {
    if (!confirm(`Rotate the database password for ${d!.name}? The new password is shown once; apps must restart to pick it up.`)) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.setDbPassword(d!.name);
      setPw(r.password);
      setPwWarn(r.warning ?? null);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        {!d ? (
          <div className="spin">loading…</div>
        ) : (
          <>
            <div className="dhead">
              <div>
                <div className="dname">
                  {d.name} <TypeBadge t={d.type} />
                </div>
                {(d.type === "site" || d.type === "app") && (
                  <a className="dhost" href={d.url} target="_blank" rel="noreferrer">
                    {d.url.replace(/^https?:\/\//, "")} ↗
                  </a>
                )}
                <div className="downer">owner: {d.owner}</div>
              </div>
              <button className="x" onClick={onClose}>
                ✕
              </button>
            </div>
            {err && <div className="err">{err}</div>}

            {/* APP */}
            {d.type === "app" && d.app && (
              <div className="sec">
                <h3>container app</h3>
                <Field label="image">{d.app.image ?? "—"}</Field>
                <Field label="scale">{d.app.scale ? `min ${d.app.scale.min} · max ${d.app.scale.max}` : "—"}</Field>
                <Field label="status">
                  {d.app.status ? (
                    <>
                      <StatusPill reason={d.app.status.reason} /> &nbsp;{d.app.status.ready}/{d.app.status.replicas} ready
                      {d.app.status.restarts > 0 && <span className="restarts"> · {d.app.status.restarts} restarts</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </Field>
                {canDeploy && (
                  <Field label="lifecycle">
                    <button className="btn sm" disabled={busy} onClick={() => act(() => api.restartApp(d.name))}>
                      restart
                    </button>{" "}
                    {d.app.runtimeState === "stopped" ? (
                      <button className="btn sm" disabled={busy} onClick={() => act(() => api.startApp(d.name))}>
                        start
                      </button>
                    ) : (
                      <button className="btn sm danger" disabled={busy} onClick={() => act(() => api.stopApp(d.name))}>
                        stop
                      </button>
                    )}
                  </Field>
                )}
              </div>
            )}
            {d.type === "app" && <Secrets name={d.name} canManage={isOwner} onChanged={onChanged} />}

            {/* DATABASE */}
            {d.type === "database" && d.database && (
              <div className="sec">
                <h3>managed postgres</h3>
                <Field label="status">
                  {d.database.status ? (
                    <>
                      <StatusPill reason={d.database.status.phase} /> &nbsp;{d.database.status.ready}/{d.database.status.instances}
                    </>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label="host">
                  <code>
                    {d.database.host}:{d.database.port}
                  </code>
                </Field>
                <Field label="database">{d.database.database}</Field>
                <Field label="user">
                  <code>{d.database.user}</code>
                </Field>
                <Field label="credentials">
                  Secret <code>{d.database.credentialsSecret}</code> · keys <code>username</code>/<code>password</code> (not shown)
                </Field>
                {isOwner && (
                  <Field label="password">
                    {pw ? (
                      <span>
                        <code className="reveal">{pw}</code>
                        <div className="sub">shown once — copy it now. restart apps to pick up the new password.</div>
                        {pwWarn && <div className="warn">⚠ {pwWarn}</div>}
                      </span>
                    ) : (
                      <button className="btn sm" disabled={busy} onClick={rotatePw}>
                        set / rotate password
                      </button>
                    )}
                  </Field>
                )}
              </div>
            )}

            {/* SITE: versions + rollback */}
            {d.type === "site" && (
              <div className="sec">
                <h3>versions ({d.versions.length})</h3>
                {d.versions.length === 0 && <p className="muted">—</p>}
                {d.versions.map((v) => (
                  <div className="item" key={v.id}>
                    <div className="meta">
                      <b className={v.id === d.current ? "cur" : ""}>
                        #{v.id.replace(/^v_\d+_/, "")}
                        {v.id === d.current ? " · live" : ""}
                      </b>
                      <div className="sub">
                        {v.fileCount} files · {v.publishedBy}
                      </div>
                    </div>
                    {v.id !== d.current && isOwner && (
                      <button className="btn sm" disabled={busy} onClick={() => act(() => api.rollback(d.name, v.id))}>
                        rollback
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* logs for apps + databases */}
            {(d.type === "app" || d.type === "database") && <Logs name={d.name} />}

            {/* collaborators (all types) */}
            <div className="sec">
              <h3>access</h3>
              <div className="item">
                <div className="meta">
                  <b>{d.owner}</b>
                  <div className="sub">owner</div>
                </div>
              </div>
              {d.collaborators.map((em) => (
                <div className="item" key={em}>
                  <div className="meta">
                    <b>{em}</b>
                    <div className="sub">collaborator</div>
                  </div>
                  {isOwner && (
                    <button className="btn sm danger" disabled={busy} onClick={() => act(() => api.removeCollaborator(d.name, em))}>
                      remove
                    </button>
                  )}
                </div>
              ))}
              {isOwner && (
                <AddRow
                  placeholder="teammate@example.com"
                  cta="share"
                  onSubmit={(email) => act(() => api.addCollaborator(d.name, email))}
                />
              )}
            </div>

            {/* danger zone */}
            {isOwner && (
              <div className="sec">
                <h3>danger</h3>
                {d.type !== "database" && (
                  <AddRow
                    placeholder="new-owner@example.com"
                    cta="transfer"
                    confirm={(e) => `Transfer ${d.name} to ${e}? You become a collaborator.`}
                    onSubmit={(email) => act(() => api.transfer(d.name, email), true)}
                  />
                )}
                <button
                  className="btn danger wide"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Delete ${d.name}? This tears down its workload${d.type === "database" ? " and data" : ""}.`))
                      void act(() => api.remove(d.name), true);
                  }}
                >
                  delete {d.type}
                </button>
              </div>
            )}
          </>
        )}
      </aside>
    </>
  );
}

function AddRow({
  placeholder,
  cta,
  onSubmit,
  confirm: confirmMsg,
}: {
  placeholder: string;
  cta: string;
  onSubmit: (v: string) => void;
  confirm?: (v: string) => string;
}) {
  const [v, setV] = useState("");
  return (
    <div className="addrow">
      <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} />
      <button
        className="btn sm"
        disabled={!v.trim()}
        onClick={() => {
          const val = v.trim();
          if (!val) return;
          if (confirmMsg && !confirm(confirmMsg(val))) return;
          onSubmit(val);
          setV("");
        }}
      >
        {cta}
      </button>
    </div>
  );
}

function WorkloadGrid({ items, onOpen }: { items: ListItem[]; onOpen: (n: string) => void }) {
  const groups: { t: WorkloadType; label: string }[] = [
    { t: "app", label: "Apps" },
    { t: "database", label: "Databases" },
    { t: "site", label: "Sites" },
  ];
  return (
    <>
      {groups.map(({ t, label }) => {
        const g = items.filter((w) => w.type === t);
        if (!g.length) return null;
        return (
          <section key={t}>
            <h2>
              {label} <span className="count">{g.length}</span>
            </h2>
            <div className="grid">
              {g.map((w) => (
                <Card key={w.name} w={w} onOpen={() => onOpen(w.name)} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function Admin({ me, onOpen }: { me: Me; onOpen: (n: string) => void }) {
  const [items, setItems] = useState<ListItem[]>([]);
  const [type, setType] = useState("");
  const [owner, setOwner] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setErr("");
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    if (owner) qs.set("owner", owner);
    try {
      setItems((await api.adminList(qs.toString())).sites);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [type, owner]);
  useEffect(() => {
    void load();
  }, [load]);

  const suspend = async (email: string, status: "active" | "suspended") => {
    try {
      await api.setUserStatus(email, status);
      alert(`${email} → ${status}`);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <section>
      <div className="adminbar">
        <h2>All tenants</h2>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">all types</option>
          <option value="app">apps</option>
          <option value="database">databases</option>
          <option value="site">sites</option>
        </select>
        <input placeholder="owner email…" value={owner} onChange={(e) => setOwner(e.target.value)} />
      </div>
      {err && <div className="err">{err}</div>}
      <table className="tbl">
        <thead>
          <tr>
            <th>name</th>
            <th>type</th>
            <th>owner</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.name}>
              <td>
                <button className="link" onClick={() => onOpen(w.name)}>
                  {w.name}
                </button>
              </td>
              <td>
                <TypeBadge t={w.type} />
              </td>
              <td className="muted">{w.owner}</td>
              <td className="right">
                {w.owner !== me.email && (
                  <>
                    <button className="btn sm danger" onClick={() => suspend(w.owner, "suspended")}>
                      suspend owner
                    </button>{" "}
                    <button className="btn sm" onClick={() => suspend(w.owner, "active")}>
                      reactivate
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {!items.length && (
            <tr>
              <td colSpan={4} className="muted">
                no workloads
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [gated, setGated] = useState(false);
  const [view, setView] = useState<"mine" | "admin">("mine");
  const [items, setItems] = useState<ListItem[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch(() => setGated(true));
  }, []);
  const refresh = useCallback(() => {
    api.list().then((r) => setItems(r.sites)).catch(() => {});
  }, []);
  useEffect(() => {
    if (me) refresh();
  }, [me, refresh]);

  if (gated)
    return (
      <div className="gate">
        <div className="brand">
          <span className="tri">▸</span> drop
        </div>
        <p>Sign in to manage your sites, apps, and databases.</p>
        <a className="btn primary" href="/login">
          Sign in with Google →
        </a>
      </div>
    );
  if (!me) return <div className="spin big">loading…</div>;

  return (
    <div>
      <header>
        <div className="brand">
          <span className="tri">▸</span> drop <span className="tag">console</span>
        </div>
        <nav>
          <button className={view === "mine" ? "navlink on" : "navlink"} onClick={() => setView("mine")}>
            my workloads
          </button>
          {me.admin && (
            <button className={view === "admin" ? "navlink on" : "navlink"} onClick={() => setView("admin")}>
              all tenants
            </button>
          )}
          <span className="who">{me.email}</span>
          <a className="navlink" href="/logout">
            logout
          </a>
        </nav>
      </header>
      <main>
        {view === "mine" ? (
          items.length ? (
            <WorkloadGrid items={items} onOpen={setOpen} />
          ) : (
            <div className="empty">
              <p>No workloads yet.</p>
              <p className="muted">
                Ship one from the CLI: <code>drop deploy ./app</code> · <code>drop db:create mydb</code> ·{" "}
                <code>drop publish ./site</code>
              </p>
            </div>
          )
        ) : (
          <Admin me={me} onOpen={setOpen} />
        )}
      </main>
      {open && (
        <Drawer
          name={open}
          me={me}
          onClose={() => setOpen(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
