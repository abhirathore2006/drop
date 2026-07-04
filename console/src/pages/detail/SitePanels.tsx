// Static-site detail panels: drop-to-publish + version history + rollback.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { DropZone } from "../../components/DropZone.tsx";
import { useToast } from "../../components/Toast.tsx";
import { api, fmtStamp, shortVersion, type Detail } from "../../lib/api.ts";
import type { DroppedFile } from "../../lib/dropFiles.ts";
import { publishFiles } from "../../lib/publish.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { useWorkloadAction } from "./useWorkloadAction.ts";

// M2: gate this zone behind the `publish` capability once the capabilities API lands.
// For now it renders for every viewer of the site; the server's own ownership check
// (POST /v1/sites/:name/versions → 403 for non-owners) is the real gate, surfaced via toast.
function PublishDropZone({ name }: { name: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);

  const publish = useMutation({
    mutationFn: (files: DroppedFile[]) => {
      setProgress(0);
      return publishFiles(name, files, setProgress);
    },
    onSuccess: async (res) => {
      setProgress(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ["/v1/sites"] }), qc.invalidateQueries({ queryKey: ["/v1/sites", name] })]);
      toast.success(`published — live at ${res.url}`);
    },
    onError: (e) => {
      setProgress(null);
      toast.error((e as Error).message);
    },
  });

  return (
    <DropZone
      label="Drop a folder here to publish a new version"
      disabled={publish.isPending}
      progress={progress}
      onFiles={(files) => {
        if (!files.length) {
          toast.error("no files found in that folder");
          return;
        }
        publish.mutate(files);
      }}
    />
  );
}

export function SitePanels({ d, isOwner }: { d: Detail; isOwner: boolean }) {
  const act = useWorkloadAction({ success: "rolled back" });
  return (
    <>
      <div className="sec">
        <h3>versions ({d.versions.length})</h3>
        <PublishDropZone name={d.name} />
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
      <PreviewsPanel d={d} isOwner={isOwner} />
    </>
  );
}

// (E1) Active previews (label, expiry, URL) with a remove button. Creating a NEW preview from the
// console UI (a drop-zone-style publish with a label field) is a follow-up — E2: today previews are
// created via `drop publish --preview` or a CI job (docs/previews.html); the M0.5 drop zone above
// stays untouched (it always publishes the LIVE version, never a preview).
function PreviewsPanel({ d, isOwner }: { d: Detail; isOwner: boolean }) {
  const previews = d.previews ?? [];
  const rm = useWorkloadAction({ success: "preview removed" });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  if (previews.length === 0) return null; // nothing to show — keep the panel list uncluttered
  return (
    <div className="sec">
      <h3>previews ({previews.length})</h3>
      {previews.map((p) => (
        <div className="item" key={p.label}>
          <div className="meta">
            <b>{p.label}</b>
            <div className="sub">
              <a href={p.url} target="_blank" rel="noreferrer">
                {p.url.replace(/^https?:\/\//, "")}
              </a>
              {" · expires "}
              {fmtStamp(p.expiresAt)}
            </div>
          </div>
          {isOwner && (
            <Button size="sm" variant="danger" loading={rm.isPending} onClick={() => setConfirmRemove(p.label)}>
              remove
            </Button>
          )}
        </div>
      ))}
      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove preview ${confirmRemove ?? ""}`}
        body={
          <>
            Remove the preview <b>{confirmRemove}</b> on <b>{d.name}</b>? Its URL stops resolving immediately.
          </>
        }
        confirmLabel="remove"
        danger
        busy={rm.isPending}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => rm.mutate(() => api.removePreview(d.name, confirmRemove!), { onSuccess: () => setConfirmRemove(null) })}
      />
    </div>
  );
}
