import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button.tsx";
import { api } from "../../lib/api.ts";

/** On-demand logs (apps + databases): fetched only when asked, never polled. */
export function LogsPanel({ name }: { name: string }) {
  const q = useQuery({
    queryKey: ["/v1/sites", name, "logs"],
    queryFn: () => api.logs(name),
    enabled: false, // manual: the button drives refetch()
    staleTime: Infinity,
  });
  const loaded = q.data !== undefined || q.isError;
  return (
    <div className="sec">
      <div className="sec-h">
        <h3>logs</h3>
        <Button size="sm" loading={q.isFetching} onClick={() => void q.refetch()}>
          {loaded ? "refresh" : "load"}
        </Button>
      </div>
      {q.isError && <div className="err">error: {q.error.message}</div>}
      {q.data !== undefined && <pre className="logs">{q.data.logs || "(no logs)"}</pre>}
    </div>
  );
}
