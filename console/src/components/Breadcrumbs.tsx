// Detail-page breadcrumbs (M1): org / resource. Rendered by the shell around the routed
// page, so no detail-page file is touched. The org segment is derived from the ALREADY
// CACHED list queries (/v1/sites, /v1/stacks) — it adds no API call; if the list isn't in
// cache yet the crumb simply omits the org until it loads.
//
// C2: the stack crumb (org / <stack> / resource) is intentionally absent — a workload's
// list row doesn't carry which stack owns it, and the plan forbids adding an API call to
// find out. It lands with C2 (canvas editing), which threads stack membership through.
import { Link, useLocation } from "wouter";
import { orgLabel } from "../lib/api.ts";
import { useWorkloadsQuery, useStacksQuery } from "./workloads.tsx";

const DETAIL = /^\/(site|app|database|bucket)\/(.+)$/;
const STACK = /^\/stack\/(.+)$/;

export function Breadcrumbs() {
  const [loc] = useLocation();
  // Read-only cache hits (no polling) — these share keys with the list pages/sidebar.
  const sitesQ = useWorkloadsQuery(false);
  const stacksQ = useStacksQuery(false);

  const detail = DETAIL.exec(loc);
  const stack = STACK.exec(loc);
  if (!detail && !stack) return null;

  let org: { slug: string; name: string; kind: string } | null | undefined;
  let name: string;

  if (detail) {
    name = decodeURIComponent(detail[2]!);
    org = sitesQ.data?.sites.find((w) => w.name === name && w.type === detail[1])?.org ?? undefined;
  } else {
    name = decodeURIComponent(stack![1]!);
    org = stacksQ.data?.stacks.find((s) => s.name === name)?.org ?? undefined;
  }

  return (
    <nav className="crumbs" aria-label="breadcrumb">
      {org && (
        <>
          <Link href={`/?org=${encodeURIComponent(org.slug)}`} className="crumb">
            {orgLabel(org)}
          </Link>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
        </>
      )}
      <span className="crumb current" aria-current="page">
        {name}
      </span>
    </nav>
  );
}
