// Activity (M1 + G3). Two surfaces:
//  - the per-ORG events feed (G3) — deploys/crash-loops/stack-halts/quota warnings/preview-expiry,
//    scoped to the org context (?org). Visible to EVERY member (events are org-scoped, not admin-only).
//  - the platform audit trail (admins only) — the append-only mutating-action log with actor/action
//    filters + keyset paging. Rendered below the events feed for admins.
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { Table, type Column } from "../components/Table.tsx";
import { Time } from "../components/Time.tsx";
import { ActorLabel } from "../components/badges.tsx";
import { useOrgsQuery } from "../components/OrgSwitcher.tsx";
import { api, type AuditRecord, type EventRecord, type Me } from "../lib/api.ts";
import { useDebounced, useDocumentTitle } from "../lib/hooks.ts";
import { currentOrg, useOrgParam } from "../lib/org.ts";

/** Severity → pill class (mirrors the workload status pills). A resolved incident overrides to "ok". */
function severityPill(e: EventRecord): { label: string; cls: string } {
  if (e.resolvedAt) return { label: "resolved", cls: "pill-ok" };
  if (e.severity === "error") return { label: "error", cls: "pill-danger" };
  if (e.severity === "warning") return { label: "warning", cls: "pill-warn" };
  return { label: "info", cls: "pill-idle" };
}

export function ActivityPage({ me }: { me: Me }) {
  useDocumentTitle("activity · drop");
  const [param] = useOrgParam();
  const org = currentOrg(useOrgsQuery().data?.orgs, param);
  return (
    <section>
      <h2>Activity</h2>
      {org ? <EventFeed slug={org.slug} /> : <EmptyState title="Pick an org.">The events feed is per-org — choose one from the switcher in the sidebar.</EmptyState>}
      {me.admin && (
        <div style={{ marginTop: "2rem" }}>
          <h3>Audit trail</h3>
          <p className="sub">Every mutating/admin action across the platform (admin-only).</p>
          <AuditTrail />
        </div>
      )}
    </section>
  );
}

function EventFeed({ slug }: { slug: string }) {
  const q = useInfiniteQuery({
    queryKey: ["/v1/orgs", slug, "events"],
    queryFn: ({ pageParam }) => api.orgEvents(slug, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000, // keep the feed live-ish (the badge polls faster via /v1/me)
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];

  const columns: Column<EventRecord>[] = [
    { key: "when", header: "when", render: (e) => <Time at={e.createdAt} className="muted" /> },
    {
      key: "severity",
      header: "severity",
      render: (e) => {
        const p = severityPill(e);
        return <span className={`pill ${p.cls}`}>{p.label}</span>;
      },
    },
    { key: "kind", header: "kind", render: (e) => <code>{e.kind}</code> },
    { key: "what", header: "what", render: (e) => e.title },
    { key: "resource", header: "resource", render: (e) => e.siteName ?? "—" },
    { key: "detail", header: "detail", render: (e) => <span className="muted">{e.detail ? JSON.stringify(e.detail) : "—"}</span> },
  ];

  return (
    <>
      {q.isError && <div className="err">{q.error.message}</div>}
      <Table
        columns={columns}
        rows={events}
        rowKey={(e) => e.id}
        empty="no events yet — deploys, crash-loops, and quota warnings will show here"
        loadMore={{ hasMore: !!q.hasNextPage, onLoadMore: () => void q.fetchNextPage(), loading: q.isFetchingNextPage }}
      />
    </>
  );
}

function AuditTrail() {
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
    { key: "when", header: "when", render: (e) => <Time at={e.at} className="muted" /> },
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
      <Table
        columns={columns}
        rows={entries}
        rowKey={(e) => e.id}
        empty="no audit events"
        loadMore={{ hasMore: !!q.hasNextPage, onLoadMore: () => void q.fetchNextPage(), loading: q.isFetchingNextPage }}
      />
    </>
  );
}
