import { EmptyState } from "../components/EmptyState.tsx";
import { SkeletonCards } from "../components/Skeleton.tsx";
import { UsageSummary, WorkloadGrid, useWorkloadsQuery } from "../components/workloads.tsx";
import { POLL_LIST_MS } from "../lib/query.ts";

export function WorkloadsPage() {
  const q = useWorkloadsQuery(POLL_LIST_MS);
  if (q.isPending) return <SkeletonCards count={6} />;
  if (q.isError) return <div className="err">couldn't load workloads: {q.error.message}</div>;
  const items = q.data.sites;
  if (!items.length)
    return (
      <EmptyState title="No workloads yet.">
        Ship one from the CLI: <code>drop deploy ./app</code> · <code>drop db create mydb</code> · <code>drop publish ./site</code>
      </EmptyState>
    );
  return (
    <>
      <UsageSummary items={items} />
      <WorkloadGrid items={items} />
    </>
  );
}
