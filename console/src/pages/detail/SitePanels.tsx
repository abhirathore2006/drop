// Static-site detail panels: version history + rollback.
import { Button } from "../../components/Button.tsx";
import { api, shortVersion, type Detail } from "../../lib/api.ts";
import { useWorkloadAction } from "./useWorkloadAction.ts";

export function SitePanels({ d, isOwner }: { d: Detail; isOwner: boolean }) {
  const act = useWorkloadAction({ success: "rolled back" });
  return (
    <div className="sec">
      <h3>versions ({d.versions.length})</h3>
      {d.versions.length === 0 && <p className="muted">—</p>}
      {d.versions.map((v) => (
        <div className="item" key={v.id}>
          <div className="meta">
            <b className={v.id === d.current ? "cur" : ""}>
              {shortVersion(v.id)}
              {v.id === d.current ? " · live" : ""}
            </b>
            <div className="sub">
              {v.fileCount} files · {v.publishedBy}
            </div>
          </div>
          {v.id !== d.current && isOwner && (
            <Button size="sm" loading={act.isPending} onClick={() => act.mutate(() => api.rollback(d.name, v.id))}>
              rollback
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
