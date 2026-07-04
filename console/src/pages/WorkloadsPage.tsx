import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import { DropZone } from "../components/DropZone.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { NamePromptModal } from "../components/NamePromptModal.tsx";
import { Onboarding } from "../components/Onboarding.tsx";
import { useOrgsQuery } from "../components/OrgSwitcher.tsx";
import { SkeletonCards } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { UsageSummary, WorkloadGrid, useWorkloadsQuery } from "../components/workloads.tsx";
import type { DroppedFile } from "../lib/dropFiles.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { newSiteIntent } from "../lib/newSiteIntent.ts";
import { currentOrg, filterByOrg, useOrgParam } from "../lib/org.ts";
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
  const zoneRef = useRef<HTMLDivElement>(null);

  // The command palette's "new site" verb signals here — scroll the zone into view and
  // focus its picker so the keyboard flow lands somewhere useful.
  const intent = useSyncExternalStore(newSiteIntent.subscribe, newSiteIntent.getSnapshot, newSiteIntent.getSnapshot);
  useEffect(() => {
    if (intent === 0) return;
    const el = zoneRef.current;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [intent]);

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
    <div ref={zoneRef} id="new-site-zone">
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
    </div>
  );
}

export function WorkloadsPage() {
  useDocumentTitle("workloads · drop");
  const q = useWorkloadsQuery(POLL_LIST_MS);
  const [param] = useOrgParam();
  const org = currentOrg(useOrgsQuery().data?.orgs, param);

  const all = q.data?.sites ?? [];
  const items = filterByOrg(all, org);

  if (q.isPending) return <SkeletonCards count={6} />;
  if (q.isError) return <div className="err">couldn't load workloads: {q.error.message}</div>;

  // True first run: the user has NO workloads anywhere. Show onboarding with the drop zone
  // as the no-CLI path. (An org filter that merely happens to be empty is a milder state.)
  if (all.length === 0) {
    return (
      <Onboarding>
        <NewSitePublishZone />
      </Onboarding>
    );
  }

  return (
    <>
      <NewSitePublishZone />
      {items.length === 0 ? (
        <EmptyState title="No workloads in this org.">
          Switch orgs from the sidebar, or ship one here: <code>drop deploy ./app</code> · <code>drop db create mydb</code> — or drop a folder above.
        </EmptyState>
      ) : (
        <>
          <UsageSummary items={items} />
          <WorkloadGrid items={items} />
        </>
      )}
    </>
  );
}
