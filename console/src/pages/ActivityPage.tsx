// Activity (M1). Two audiences:
//  - platform admins get the append-only audit trail (the existing /v1/admin/audit
//    endpoint) with actor/action filters + keyset paging.
//  - everyone else gets an honest empty state — a per-org, non-admin activity feed needs
//    the G3 `events` table, which doesn't exist yet.
//
// G3: when the org events feed lands (POST-emitted `events`, keyset-paged per org), render
// it here for non-admins (and above the audit trail for admins), plus an SSE live tail.
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Table, type Column } from "../components/Table.tsx";
import { ActorLabel } from "../components/badges.tsx";
import { api, fmtStamp, type AuditRecord, type Me } from "../lib/api.ts";
import { useDebounced, useDocumentTitle } from "../lib/hooks.ts";

export function ActivityPage({ me }: { me: Me }) {
  useDocumentTitle("activity · drop");
  return (
    <section>
      <h2>Activity</h2>
      {me.admin ? <AuditTrail /> : <EmptyState title="No activity feed yet.">The org activity feed arrives with events — deploys, crash-loops, and quota warnings will stream here.</EmptyState>}
    </section>
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
