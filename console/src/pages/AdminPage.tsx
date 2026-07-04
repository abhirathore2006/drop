// Admin views: tenants (all-orgs flat table or one org grouped like "my workloads"),
// platform users (role + suspension), and the append-only audit trail.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Table, type Column } from "../components/Table.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { useToast } from "../components/Toast.tsx";
import { ActorLabel, TypeBadge } from "../components/badges.tsx";
import { UsageSummary, WorkloadGrid } from "../components/workloads.tsx";
import { api, fmtStamp, orgLabel, pathFor, type AdminOrg, type AdminQuotas, type AdminUser, type AuditRecord, type ListItem, type Me } from "../lib/api.ts";
import { useDebounced, useDocumentTitle } from "../lib/hooks.ts";
import { POLL_LIST_MS } from "../lib/query.ts";

type AdminTab = "tenants" | "users" | "quotas" | "audit";

export function AdminPage({ me }: { me: Me }) {
  useDocumentTitle("admin · drop");
  const [tab, setTab] = useState<AdminTab>("tenants");
  return (
    <section>
      <Tabs
        tabs={[
          { id: "tenants", label: "tenants" },
          { id: "users", label: "users" },
          { id: "quotas", label: "quotas" },
          { id: "audit", label: "audit" },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === "users" ? <AdminUsers me={me} /> : tab === "quotas" ? <QuotaEditor /> : tab === "audit" ? <AdminAudit /> : <AdminTenants me={me} />}
    </section>
  );
}

function AdminTenants({ me }: { me: Me }) {
  const [type, setType] = useState("");
  const [owner, setOwner] = useState("");
  const [org, setOrg] = useState(""); // "" = all (flat table); a slug = that org's resources, grouped
  const ownerD = useDebounced(owner);

  const orgsQ = useQuery({ queryKey: ["/v1/admin/orgs"], queryFn: api.adminOrgs, staleTime: 60_000 });
  const orgs = orgsQ.data?.orgs ?? [];

  const qs = new URLSearchParams();
  if (org) qs.set("org", org); // org view ignores the type/owner filters — it's the whole org
  else {
    if (type) qs.set("type", type);
    if (ownerD) qs.set("owner", ownerD);
  }
  const listQ = useQuery({
    queryKey: ["/v1/admin/sites", qs.toString()],
    queryFn: () => api.adminList(qs.toString()),
    refetchInterval: POLL_LIST_MS,
    placeholderData: keepPreviousData,
  });
  const items = listQ.data?.sites ?? [];

  const qc = useQueryClient();
  const toast = useToast();
  const suspend = useMutation({
    mutationFn: ({ email, status }: { email: string; status: "active" | "suspended" }) => api.setUserStatus(email, status),
    onSuccess: async (_r, v) => {
      toast.success(`${v.email} → ${v.status}`);
      await qc.invalidateQueries({ queryKey: ["/v1/admin/users"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const orgOpt = (o: AdminOrg) => (o.kind === "personal" ? `👤 ${o.owner}` : `🏢 ${o.name}`) + ` (${o.slug})`;
  const selected = orgs.find((o) => o.slug === org);

  const columns: Column<ListItem>[] = [
    { key: "name", header: "name", render: (w) => <Link className="link" href={pathFor(w)}>{w.name}</Link> },
    { key: "type", header: "type", render: (w) => <TypeBadge t={w.type} /> },
    { key: "owner", header: "owner", render: (w) => <span className="muted">{w.owner}</span> },
    {
      key: "org",
      header: "org",
      render: (w) =>
        w.org ? (
          <button className="link" onClick={() => setOrg(w.org!.slug)} title="view this org">
            {orgLabel(w.org)}
          </button>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (w) =>
        w.owner !== me.email ? (
          <>
            <Button size="sm" variant="danger" loading={suspend.isPending} onClick={() => suspend.mutate({ email: w.owner, status: "suspended" })}>
              suspend owner
            </Button>{" "}
            <Button size="sm" loading={suspend.isPending} onClick={() => suspend.mutate({ email: w.owner, status: "active" })}>
              reactivate
            </Button>
          </>
        ) : null,
    },
  ];

  return (
    <>
      <div className="adminbar">
        <h2>{selected ? (selected.kind === "personal" ? selected.owner : selected.name) : "All tenants"}</h2>
        {/* Pick an org → see all its resources grouped (apps/dbs/sites), like "my workloads". */}
        <select value={org} onChange={(e) => setOrg(e.target.value)} aria-label="org filter">
          <option value="">all orgs (flat list)</option>
          {orgs.map((o) => (
            <option key={o.slug} value={o.slug}>
              {orgOpt(o)}
            </option>
          ))}
        </select>
        {!org && (
          <>
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="type filter">
              <option value="">all types</option>
              <option value="app">apps</option>
              <option value="database">databases</option>
              <option value="site">sites</option>
            </select>
            <input placeholder="owner email…" value={owner} onChange={(e) => setOwner(e.target.value)} />
          </>
        )}
      </div>
      {listQ.isError && <div className="err">{listQ.error.message}</div>}
      {org ? (
        items.length ? (
          <>
            <UsageSummary items={items} />
            <WorkloadGrid items={items} />
          </>
        ) : (
          <EmptyState>no resources in this org yet</EmptyState>
        )
      ) : (
        <Table columns={columns} rows={items} rowKey={(w) => w.name} empty="no workloads" />
      )}
    </>
  );
}

/** Manage every platform user — toggle the platform-admin role + suspend/reactivate.
 *  Self-actions are hidden (no self-lockout / no self-demotion, enforced server-side too). */
function AdminUsers({ me }: { me: Me }) {
  const q = useQuery({ queryKey: ["/v1/admin/users"], queryFn: api.adminUsers, refetchInterval: POLL_LIST_MS });
  const qc = useQueryClient();
  const toast = useToast();
  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/v1/admin/users"] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const columns: Column<AdminUser>[] = [
    { key: "email", header: "email", render: (u) => u.email },
    {
      key: "role",
      header: "role",
      render: (u) => (u.role === "admin" ? <span className="pill pill-ok">admin</span> : <span className="muted">member</span>),
    },
    {
      key: "status",
      header: "status",
      render: (u) => (u.status === "suspended" ? <span className="pill pill-danger">suspended</span> : <span className="muted">active</span>),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (u) =>
        u.email !== me.email ? (
          <>
            {u.role === "admin" ? (
              <Button size="sm" loading={act.isPending} onClick={() => act.mutate(() => api.setUserRole(u.email, "member"))}>
                revoke admin
              </Button>
            ) : (
              <Button size="sm" loading={act.isPending} onClick={() => act.mutate(() => api.setUserRole(u.email, "admin"))}>
                make admin
              </Button>
            )}{" "}
            {u.status === "suspended" ? (
              <Button size="sm" loading={act.isPending} onClick={() => act.mutate(() => api.setUserStatus(u.email, "active"))}>
                reactivate
              </Button>
            ) : (
              <Button size="sm" variant="danger" loading={act.isPending} onClick={() => act.mutate(() => api.setUserStatus(u.email, "suspended"))}>
                suspend
              </Button>
            )}
          </>
        ) : null,
    },
  ];

  return (
    <>
      {q.isError && <div className="err">{q.error.message}</div>}
      <Table columns={columns} rows={q.data?.users ?? []} rowKey={(u) => u.email} empty="no users" />
    </>
  );
}

// ---- per-org quota editor (item 10) — override the instance defaults for cpu/storage/workload caps.
const QUOTA_LABEL: Record<string, string> = {
  max_workloads: "max workloads",
  max_db_storage: "max db storage (per database)",
  storage_budget_bytes: "storage budget (org-wide)",
};
const QUOTA_HINT: Record<string, string> = {
  max_workloads: "non-negative integer; 0 = unlimited",
  max_db_storage: "k8s quantity, e.g. 512Mi, 1Gi, 5Gi",
  storage_budget_bytes: "a byte count or a k8s quantity, e.g. 10Gi",
};

/** The instance-default (effective-when-unset) value for a key, as a human string — the "default hint". */
function effectiveLabel(data: AdminQuotas, key: string): string {
  if (key === "max_workloads") return data.effective.max_workloads === 0 ? "unlimited" : String(data.effective.max_workloads);
  if (key === "max_db_storage") return data.effective.max_db_storage;
  if (key === "storage_budget_bytes") return data.effective.storage_budget_bytes == null ? "no budget" : `${data.effective.storage_budget_bytes} bytes`;
  return "—";
}

/** Admin: pick an org, then edit its per-org quota overrides. Unset keys fall back to the instance
 *  default (shown as a hint). Server-side validation is authoritative (PUT → 400 with a message). */
export function QuotaEditor() {
  const orgsQ = useQuery({ queryKey: ["/v1/admin/orgs"], queryFn: api.adminOrgs, staleTime: 60_000 });
  const orgs = orgsQ.data?.orgs ?? [];
  const [slug, setSlug] = useState("");
  const q = useQuery({ queryKey: ["/v1/admin/orgs", slug, "quotas"], queryFn: () => api.adminOrgQuotas(slug), enabled: !!slug });
  const orgOpt = (o: AdminOrg) => (o.kind === "personal" ? `👤 ${o.owner}` : `🏢 ${o.name}`) + ` (${o.slug})`;

  return (
    <>
      <div className="adminbar">
        <h2>Per-org quotas</h2>
        <select value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="org">
          <option value="">pick an org…</option>
          {orgs.map((o) => (
            <option key={o.slug} value={o.slug}>
              {orgOpt(o)}
            </option>
          ))}
        </select>
      </div>
      {!slug ? (
        <EmptyState title="Pick an org.">Choose an org to view and edit its resource quota overrides. Unset keys fall back to the instance defaults.</EmptyState>
      ) : q.isPending ? (
        <Skeleton lines={4} />
      ) : q.isError ? (
        <div className="err">{q.error.message}</div>
      ) : (
        <QuotaForm key={slug} slug={slug} data={q.data} />
      )}
    </>
  );
}

function QuotaForm({ slug, data }: { slug: string; data: AdminQuotas }) {
  const qc = useQueryClient();
  const toast = useToast();
  const override = (key: string) => data.overrides.find((o) => o.key === key)?.value ?? "";
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(data.keys.map((k) => [k, override(k)])));
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      // Only send keys whose value is non-empty AND changed from the stored override. (There is no
      // "unset" — clearing an override isn't supported yet, so a blanked field is a no-op.)
      const changed: Record<string, string> = {};
      for (const k of data.keys) {
        const v = (vals[k] ?? "").trim();
        if (v && v !== override(k)) changed[k] = v;
      }
      if (Object.keys(changed).length === 0) return Promise.reject(new Error("no changes to save"));
      return api.setAdminOrgQuotas(slug, changed);
    },
    onSuccess: async () => {
      toast.success("quotas saved");
      await qc.invalidateQueries({ queryKey: ["/v1/admin/orgs", slug, "quotas"] });
    },
    onError: (e) => setErr((e as Error).message),
  });

  // Light client-side check for quick feedback; the server validates authoritatively.
  const validate = (): string | null => {
    const mw = (vals["max_workloads"] ?? "").trim();
    if (mw && !/^\d+$/.test(mw)) return "max workloads must be a non-negative integer (0 = unlimited)";
    return null;
  };

  return (
    <div className="panels">
      <div className="sec">
        <div className="sec-h">
          <h3>{data.org.name} — quota overrides</h3>
        </div>
        {data.keys.map((k) => {
          const isOverride = data.overrides.some((o) => o.key === k);
          return (
            <div className="kv" key={k}>
              <span className="k">{QUOTA_LABEL[k] ?? k}</span>
              <span className="v" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="input"
                  style={{ maxWidth: "12rem" }}
                  value={vals[k] ?? ""}
                  placeholder={`default: ${effectiveLabel(data, k)}`}
                  aria-label={k}
                  onChange={(e) => {
                    setVals((s) => ({ ...s, [k]: e.target.value }));
                    if (err) setErr(null);
                  }}
                />
                <span className="sub">
                  {isOverride ? "override" : "default"} · effective {effectiveLabel(data, k)} · {QUOTA_HINT[k]}
                </span>
              </span>
            </div>
          );
        })}
        {err && <div className="field-err">{err}</div>}
        <div className="field">
          <Button
            size="sm"
            variant="primary"
            loading={save.isPending}
            onClick={() => {
              const v = validate();
              if (v) {
                setErr(v);
                return;
              }
              save.mutate();
            }}
          >
            save
          </Button>
        </div>
        <p className="sub">Unset keys use the instance default. Clearing an existing override isn't supported yet — set a new value to change it.</p>
      </div>
    </div>
  );
}

/** Append-only audit trail (newest first) with actor/action filters + keyset paging. */
function AdminAudit() {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const actorD = useDebounced(actor);
  const actionD = useDebounced(action);

  const q = useInfiniteQuery({
    queryKey: ["/v1/admin/audit", { actor: actorD, action: actionD }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (actorD) qs.set("actor", actorD);
      if (actionD) qs.set("action", actionD);
      if (pageParam) qs.set("cursor", pageParam);
      return api.adminAudit(qs.toString());
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];

  const columns: Column<AuditRecord>[] = [
    { key: "when", header: "when", render: (e) => <span className="muted">{fmtStamp(e.at)}</span> },
    { key: "actor", header: "actor", render: (e) => <ActorLabel principal={e.actor} /> },
    { key: "action", header: "action", render: (e) => <code>{e.action}</code> },
    { key: "target", header: "target", render: (e) => e.target ?? "—" },
    { key: "detail", header: "detail", render: (e) => <span className="muted">{e.detail ? JSON.stringify(e.detail) : "—"}</span> },
  ];

  return (
    <>
      <div className="adminbar">
        <input placeholder="actor email…" value={actor} onChange={(e) => setActor(e.target.value)} />
        <input placeholder="action, e.g. site.delete" value={action} onChange={(e) => setAction(e.target.value)} />
      </div>
      {q.isError && <div className="err">{q.error.message}</div>}
      <Table columns={columns} rows={entries} rowKey={(e) => e.id} empty="no audit events" />
      {q.hasNextPage && (
        <Button size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          load more
        </Button>
      )}
    </>
  );
}
