// Stacks list (M1). The stacks that used to sit above the workloads grid now get their own
// page; the cards link to the read-only canvas (/stack/<name>). Org-scoped by ?org context.
import { Link } from "wouter";
import { EmptyState } from "../components/EmptyState.tsx";
import { SkeletonCards } from "../components/Skeleton.tsx";
import { useStacksQuery } from "../components/workloads.tsx";
import { useOrgsQuery } from "../components/OrgSwitcher.tsx";
import { orgLabel } from "../lib/api.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { currentOrg, filterByOrg, useOrgParam } from "../lib/org.ts";
import { POLL_LIST_MS } from "../lib/query.ts";

export function StacksPage() {
  useDocumentTitle("stacks · drop");
  const q = useStacksQuery(POLL_LIST_MS);
  const [param] = useOrgParam();
  const org = currentOrg(useOrgsQuery().data?.orgs, param);
  const stacks = filterByOrg(q.data?.stacks ?? [], org);

  return (
    <section>
      <h2>
        Stacks {stacks.length > 0 && <span className="count">{stacks.length}</span>}
      </h2>
      {q.isPending ? (
        <SkeletonCards count={4} />
      ) : q.isError ? (
        <div className="err">couldn't load stacks: {q.error.message}</div>
      ) : stacks.length === 0 ? (
        <EmptyState title="No stacks yet.">
          Declare an app, database, and their wiring in one <code>drop.yaml</code>, then <code>drop up</code> to create them together.
        </EmptyState>
      ) : (
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
                {s.fromTemplate && <span className="sub"> · from {s.fromTemplate}</span>}
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
      )}
    </section>
  );
}
