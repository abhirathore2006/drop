import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { DropZone } from "../components/DropZone.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { NamePromptModal } from "../components/NamePromptModal.tsx";
import { SkeletonCards } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { StacksSection, UsageSummary, WorkloadGrid, useWorkloadsQuery } from "../components/workloads.tsx";
import type { DroppedFile } from "../lib/dropFiles.ts";
import { publishFiles } from "../lib/publish.ts";
import { POLL_LIST_MS } from "../lib/query.ts";

// M2: gate this zone behind the (not-yet-built) capabilities API once it lands. For now
// it renders for every signed-in user; the server's own ownership check (POST
// /v1/sites/:name/versions, which auto-claims unclaimed names) is the real gate, and any
// permission failure surfaces as an error toast.
function NewSitePublishZone() {
  const qc = useQueryClient();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [pending, setPending] = useState<DroppedFile[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const publish = useMutation({
    mutationFn: (name: string) => {
      setProgress(0);
      return publishFiles(name, pending ?? [], setProgress);
    },
    onSuccess: async (res, name) => {
      setProgress(null);
      setPending(null);
      await qc.invalidateQueries({ queryKey: ["/v1/sites"] });
      toast.success(`published — live at ${res.url}`);
      navigate(`/site/${encodeURIComponent(name)}`);
    },
    onError: (e) => {
      setProgress(null);
      toast.error((e as Error).message);
    },
  });

  return (
    <>
      <DropZone
        label="Drop a folder here to publish a new site"
        disabled={publish.isPending}
        onFiles={(files) => {
          if (!files.length) {
            toast.error("no files found in that folder");
            return;
          }
          setPending(files);
        }}
      />
      <NamePromptModal
        open={pending !== null}
        busy={publish.isPending}
        progress={progress}
        onCancel={() => setPending(null)}
        onSubmit={(name) => publish.mutate(name)}
      />
    </>
  );
}

export function WorkloadsPage() {
  const q = useWorkloadsQuery(POLL_LIST_MS);
  return (
    <>
      <NewSitePublishZone />
      <StacksSection />
      {q.isPending ? (
        <SkeletonCards count={6} />
      ) : q.isError ? (
        <div className="err">couldn't load workloads: {q.error.message}</div>
      ) : !q.data.sites.length ? (
        <EmptyState title="No workloads yet.">
          Ship one from the CLI: <code>drop deploy ./app</code> · <code>drop db create mydb</code> · <code>drop publish ./site</code> — or drop a folder
          above.
        </EmptyState>
      ) : (
        <>
          <UsageSummary items={q.data.sites} />
          <WorkloadGrid items={q.data.sites} />
        </>
      )}
    </>
  );
}
