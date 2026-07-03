// Shared workload list views: grouped card grid + per-org usage cards.
// Used by both the "my workloads" page and the admin single-org view.
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, orgLabel, pathFor, shortVersion, type ListItem, type OrgUsage, type WorkloadType } from "../lib/api.ts";
import { POLL_LIST_MS } from "../lib/query.ts";
import { TypeBadge } from "./badges.tsx";

export function Card({ w }: { w: ListItem }) {
  return (
    <Link href={pathFor(w)} className="card">
      <div className="card-top">
        <span className="dot" />
        <span className="card-name">{w.name}</span>
        <TypeBadge t={w.type} />
      </div>
      <div className="card-owner">{w.owner}</div>
      <div className="card-foot">
        {w.org && (
          <span className="card-org" title={`org: ${w.org.slug}`}>
            🏢 {orgLabel(w.org)}
          </span>
        )}
        <span className="ver">{w.current ? shortVersion(w.current) : "—"}</span>
      </div>
    </Link>
  );
}

export function WorkloadGrid({ items }: { items: ListItem[] }) {
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
                <Card key={w.name} w={w} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

/** Per-org usage: workloads claimed (vs the cap) + live cluster quota. Derives the org set
 *  from the workload list, so it needs no separate org-listing call; individual usage
 *  failures are simply omitted (parity with the old console). */
export function UsageSummary({ items }: { items: ListItem[] }) {
  const slugs = [...new Set(items.map((w) => w.org?.slug).filter((s): s is string => !!s))];
  const results = useQueries({
    queries: slugs.map((slug) => ({
      queryKey: ["/v1/orgs", slug, "usage"],
      queryFn: () => api.orgUsage(slug),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const usages = results.map((r) => r.data).filter((u): u is OrgUsage => !!u);
  if (!usages.length) return null;
  return (
    <section>
      <h2>Usage</h2>
      <div className="grid">
        {usages.map((u) => (
          <div className="card" key={u.org.slug}>
            <div className="card-top">
              <span className="card-name">{u.org.kind === "personal" ? "personal" : u.org.name}</span>
            </div>
            <div className="card-owner">
              <b>{u.workloads.total}</b>
              {u.cap > 0 ? ` / ${u.cap}` : ""} workloads
            </div>
            <div className="card-foot">
              <span className="sub">
                {u.workloads.app} apps · {u.workloads.database} dbs · {u.workloads.site} sites
              </span>
            </div>
            {u.quota && (
              <div className="card-foot">
                <span className="sub">
                  cpu {u.quota.used["limits.cpu"] ?? "0"}/{u.quota.hard["limits.cpu"] ?? "—"} · pods{" "}
                  {u.quota.used["count/pods"] ?? "0"}/{u.quota.hard["count/pods"] ?? "—"}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The workloads list query — one definition so every consumer shares key + polling cadence. */
export function useWorkloadsQuery(pollMs: number | false = 15_000) {
  return useQuery({
    queryKey: ["/v1/sites"],
    queryFn: api.list,
    refetchInterval: pollMs,
  });
}

/** Stacks the caller can see (GET /v1/stacks) — shares the list polling cadence. */
export function useStacksQuery(pollMs: number | false = POLL_LIST_MS) {
  return useQuery({ queryKey: ["/v1/stacks"], queryFn: api.stacks, refetchInterval: pollMs });
}

/** C1: a Stacks grouping above the per-type workload grid. Cards link to the read-only canvas
 *  (/stack/<name>). Renders nothing until there is at least one stack (keeps the page uncluttered). */
export function StacksSection() {
  const q = useStacksQuery();
  const stacks = q.data?.stacks ?? [];
  if (!stacks.length) return null;
  return (
    <section>
      <h2>
        Stacks <span className="count">{stacks.length}</span>
      </h2>
      <div className="grid">
        {stacks.map((s) => (
          <Link key={s.name} href={`/stack/${encodeURIComponent(s.name)}`} className="card">
            <div className="card-top">
              <span className="dot" />
              <span className="card-name">{s.name}</span>
              <span className="badge badge-app">STACK</span>
            </div>
            <div className="card-owner">
              {s.resources} resource{s.resources === 1 ? "" : "s"}
            </div>
            <div className="card-foot">
              {s.org && (
                <span className="card-org" title={`org: ${s.org.slug}`}>
                  🏢 {orgLabel(s.org)}
                </span>
              )}
              <span className="ver">v{s.specVersion}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
