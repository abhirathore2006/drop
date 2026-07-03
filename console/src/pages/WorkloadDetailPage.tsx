import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Skeleton } from "../components/Skeleton.tsx";
import { api, type Me } from "../lib/api.ts";
import { POLL_DETAIL_MS } from "../lib/query.ts";
import { WorkloadFrame } from "./detail/WorkloadFrame.tsx";

export function WorkloadDetailPage({ name, me }: { name: string; me: Me }) {
  const q = useQuery({
    queryKey: ["/v1/sites", name],
    queryFn: () => api.get(name),
    refetchInterval: POLL_DETAIL_MS,
  });
  return (
    <div className="page">
      <Link href="/" className="back">
        ← all workloads
      </Link>
      {q.isPending ? (
        <Skeleton lines={6} />
      ) : q.isError ? (
        <div className="err">{q.error.message}</div>
      ) : (
        <WorkloadFrame d={q.data} me={me} />
      )}
    </div>
  );
}
