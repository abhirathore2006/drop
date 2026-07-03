// Shared workload detail frame: header (name/type/url/owner/org), per-type panels,
// access (members) and the danger zone. Decomposes the old 270-line WorkloadPage
// conditional monolith into per-type panel modules.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { AddRow, validateEmail } from "../../components/Field.tsx";
import { TypeBadge } from "../../components/badges.tsx";
import { useToast } from "../../components/Toast.tsx";
import { api, orgLabel, type Detail, type Me } from "../../lib/api.ts";
import { AppPanels } from "./AppPanels.tsx";
import { DbPanels } from "./DbPanels.tsx";
import { SitePanels } from "./SitePanels.tsx";
import { useWorkloadAction } from "./useWorkloadAction.ts";

export function WorkloadFrame({ d, me }: { d: Detail; me: Me }) {
  // Same rules the old console applied (M2 replaces this with server-computed capabilities):
  // owner/admin manage secrets + sharing + danger zone; editor+ drives lifecycle.
  const isOwner = d.owner === me.email || me.admin;
  const canDeploy = !!me.admin || d.members.some((m) => m.email === me.email && (m.role === "owner" || m.role === "editor"));

  return (
    <>
      <div className="phead">
        <div className="dname">
          {d.name} <TypeBadge t={d.type} />
        </div>
        {(d.type === "site" || d.type === "app") && (
          <a className="dhost" href={d.url} target="_blank" rel="noreferrer">
            {d.url.replace(/^https?:\/\//, "")} ↗
          </a>
        )}
        <div className="downer">
          owner: {d.owner}
          {d.org && (
            <span title={`org slug: ${d.org.slug}`}>
              {" · "}org: {orgLabel(d.org)}
              {d.org.kind !== "personal" ? ` (${d.org.slug})` : ""}
            </span>
          )}
        </div>
      </div>
      <div className="panels">
        {d.type === "site" && <SitePanels d={d} isOwner={isOwner} />}
        {d.type === "app" && <AppPanels d={d} isOwner={isOwner} canDeploy={canDeploy} />}
        {d.type === "database" && <DbPanels d={d} isOwner={isOwner} canDeploy={canDeploy} />}
        <AccessPanel d={d} isOwner={isOwner} />
        {isOwner && <DangerPanel d={d} />}
      </div>
    </>
  );
}

function AccessPanel({ d, isOwner }: { d: Detail; isOwner: boolean }) {
  const act = useWorkloadAction();
  return (
    <div className="sec">
      <h3>access</h3>
      <div className="item">
        <div className="meta">
          <b>{d.owner}</b>
          <div className="sub">owner</div>
        </div>
      </div>
      {d.collaborators.map((em) => (
        <div className="item" key={em}>
          <div className="meta">
            <b>{em}</b>
            <div className="sub">collaborator</div>
          </div>
          {isOwner && (
            <Button size="sm" variant="danger" disabled={act.isPending} onClick={() => act.mutate(() => api.removeCollaborator(d.name, em))}>
              remove
            </Button>
          )}
        </div>
      ))}
      {isOwner && (
        <AddRow
          placeholder="teammate@example.com"
          cta="share"
          validate={validateEmail}
          busy={act.isPending}
          onSubmit={(email) => act.mutate(() => api.addCollaborator(d.name, email))}
        />
      )}
    </div>
  );
}

function DangerPanel({ d }: { d: Detail }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const leave = (message: string) => {
    navigate("/");
    // Drop the dead detail query so navigating back doesn't flash stale data / 404 noise.
    qc.removeQueries({ queryKey: ["/v1/sites", d.name] });
    toast.success(message);
  };
  const transfer = useWorkloadAction({ onSuccess: () => leave(`${d.name} transferred`) });
  const del = useWorkloadAction({ onSuccess: () => leave(`${d.name} deleted`) });

  return (
    <div className="sec">
      <h3>danger</h3>
      {d.type !== "database" && (
        <AddRow placeholder="new-owner@example.com" cta="transfer" validate={validateEmail} onSubmit={(email) => setTransferTo(email)} />
      )}
      <Button variant="danger" wide disabled={transfer.isPending || del.isPending} onClick={() => setConfirmDelete(true)}>
        delete {d.type}
      </Button>

      <ConfirmDialog
        open={transferTo !== null}
        title={`Transfer ${d.name}`}
        body={
          <>
            Transfer <b>{d.name}</b> to <b>{transferTo}</b>? You become a collaborator.
          </>
        }
        confirmLabel="transfer"
        busy={transfer.isPending}
        onCancel={() => setTransferTo(null)}
        onConfirm={() => transfer.mutate(() => api.transfer(d.name, transferTo!))}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${d.name}`}
        body={<>This permanently tears down its workload{d.type === "database" ? " and data" : ""}.</>}
        confirmLabel={`delete ${d.type}`}
        danger
        typeToConfirm={d.name}
        busy={del.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => del.mutate(() => api.remove(d.name))}
      />
    </div>
  );
}
