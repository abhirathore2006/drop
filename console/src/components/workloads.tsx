// Shared workload list views: grouped card grid + per-org usage cards.
// Used by both the "my workloads" page and the admin single-org view.
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, orgLabel, pathFor, shortVersion, type ListItem, type OrgUsage, type WorkloadType } from "../lib/api.ts";
import { POLL_LIST_MS } from "../lib/query.ts";
import { metricValues, sparklineArea, sparklinePath } from "../lib/chart-data.ts";
import { TypeBadge } from "./badges.tsx";

// (M4) Types that see edge traffic — the only cards that carry a request sparkline.
const TRAFFIC_TYPES = new Set<WorkloadType>(["site", "app", "database"]);

export function Card({ w }: { w: ListItem }) {
  return (
    <Link href={pathFor(w)} className="card">
      <div className="card-top">
        <span className="dot" />
        <span className="card-name">{w.name}</span>
        <TypeBadge t={w.type} />
      </div>
      <div className="card-owner">{w.owner}</div>
      {TRAFFIC_TYPES.has(w.type) && <CardSparkline name={w.name} />}
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

/** (M4) A tiny HAND-ROLLED SVG request sparkline off the 1h series. Deliberately NOT uPlot — that keeps
 *  uPlot's chunk off the list page entirely (a list can show dozens of cards). Fetched cheaply: long
 *  staleTime, no polling, no retry; the card just omits the spark on any failure or an empty/flat window. */
function CardSparkline({ name }: { name: string }) {
  const q = useQuery({
    queryKey: ["/v1/sites", name, "metrics", "1h"],
    queryFn: () => api.metrics(name, "1h"),
    staleTime: 60_000,
    retry: false,
  });
  const series = q.data?.series;
  if (!series || series.length < 2) return null;
  const values = metricValues(series, "requests");
  if (!values.some((v) => v > 0)) return null; // no traffic → no spark (the number view still tells the story)
  const W = 148;
  const H = 22;
  return (
    <svg className="card-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="card-spark-area" d={sparklineArea(values, W, H)} />
      <path className="card-spark-line" d={sparklinePath(values, W, H)} fill="none" />
    </svg>
  );
}

export function WorkloadGrid({ items }: { items: ListItem[] }) {
  const groups: { t: WorkloadType; label: string }[] = [
    { t: "app", label: "Apps" },
    { t: "database", label: "Databases" },
    { t: "cache", label: "Caches" },
    { t: "auth", label: "Auth" },
    { t: "bucket", label: "Buckets" },
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
                {u.workloads.app} apps · {u.workloads.database} dbs · {u.workloads.cache} caches · {u.workloads.auth} auth · {u.workloads.bucket} buckets · {u.workloads.site} sites
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

/** Stacks the caller can see (GET /v1/stacks) — shares the list polling cadence. Consumed by
 *  the Stacks page, the command palette, and breadcrumbs. */
export function useStacksQuery(pollMs: number | false = POLL_LIST_MS) {
  return useQuery({ queryKey: ["/v1/stacks"], queryFn: api.stacks, refetchInterval: pollMs });
}
