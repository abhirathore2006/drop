// Shared workload detail frame: header (name/type/url/owner/org), per-type panels,
// access (members) and the danger zone. Decomposes the old 270-line WorkloadPage
// conditional monolith into per-type panel modules.
//
// M2: permission gating is server-computed. Every panel reads `d.capabilities` via lib/caps.ts —
// there is NO client-side owner/role math here anymore.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { AddRow, validateEmail } from "../../components/Field.tsx";
import { TypeBadge } from "../../components/badges.tsx";
import { useToast } from "../../components/Toast.tsx";
import { api, orgLabel, type Detail } from "../../lib/api.ts";
import { cap } from "../../lib/caps.ts";
import { AppPanels } from "./AppPanels.tsx";
import { DbPanels } from "./DbPanels.tsx";
import { BucketPanels } from "./BucketPanels.tsx";
import { CachePanels } from "./CachePanels.tsx";
import { SitePanels } from "./SitePanels.tsx";
import { MetricsPanel } from "./MetricsPanel.tsx";
import { useWorkloadAction } from "./useWorkloadAction.ts";

export function WorkloadFrame({ d }: { d: Detail }) {
  // The danger zone (delete/transfer) is a destructive, ownership-tier surface: HIDDEN unless the
  // actor holds one of those verbs (per the M2 convention).
  const showDanger = cap(d, "delete") || cap(d, "transfer");
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
        {d.type === "site" && <SitePanels d={d} />}
        {d.type === "app" && <AppPanels d={d} />}
        {d.type === "database" && <DbPanels d={d} />}
        {d.type === "bucket" && <BucketPanels d={d} />}
        {d.type === "cache" && <CachePanels d={d} />}
        {(d.type === "site" || d.type === "app" || d.type === "database") && <MetricsPanel d={d} />}
        <AccessPanel d={d} />
        {showDanger && <DangerPanel d={d} />}
      </div>
    </>
  );
}

function AccessPanel({ d }: { d: Detail }) {
  const act = useWorkloadAction();
  const canShare = cap(d, "share");
  return (
    <div className="sec">
      <h3>access</h3>
      {(d.type === "site" || d.type === "app") && <VisibilityRow d={d} />}
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
          {canShare && (
            <Button size="sm" variant="danger" disabled={act.isPending} onClick={() => act.mutate(() => api.removeCollaborator(d.name, em))}>
              remove
            </Button>
          )}
        </div>
      ))}
      {canShare && (
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

/** Who can view the served workload: public / password (basic-auth) / private. Mirrors the
 *  old console's setVisibility flow; the edge enforces it. `configure`-gated to change. */
function VisibilityRow({ d }: { d: Detail }) {
  const act = useWorkloadAction();
  const [vis, setVis] = useState(d.visibility);
  const [pw, setPw] = useState("");
  // Changing TO password needs a password; already-password keeps the stored one unless retyped.
  const needsPw = vis === "password" && d.visibility !== "password" && !pw;
  const dirty = vis !== d.visibility || (vis === "password" && pw !== "");
  if (!cap(d, "configure")) {
    return (
      <div className="item">
        <div className="meta">
          <b>visibility</b>
          <div className="sub">{d.visibility}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="item visrow">
      <div className="meta">
        <b>visibility</b>
        <div className="sub">who can view the served {d.type}</div>
      </div>
      <select className="input" aria-label="visibility" value={vis} disabled={act.isPending} onChange={(e) => setVis(e.target.value)}>
        <option value="public">public</option>
        <option value="password">password</option>
        <option value="private">private</option>
      </select>
      {vis === "password" && (
        <input
          className="input"
          type="password"
          placeholder={d.visibility === "password" ? "keep current password" : "set a password"}
          value={pw}
          disabled={act.isPending}
          onChange={(e) => setPw(e.target.value)}
        />
      )}
      <Button
        size="sm"
        disabled={!dirty || needsPw || act.isPending}
        onClick={() => act.mutate(() => api.setVisibility(d.name, vis, vis === "password" && pw ? pw : undefined), { onSuccess: () => setPw("") })}
      >
        apply
      </Button>
    </div>
  );
}

function DangerPanel({ d }: { d: Detail }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canTransfer = cap(d, "transfer");
  const canDelete = cap(d, "delete");

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
      {d.type !== "database" && canTransfer && (
        <AddRow placeholder="new-owner@example.com" cta="transfer" validate={validateEmail} onSubmit={(email) => setTransferTo(email)} />
      )}
      {canDelete && (
        <Button variant="danger" wide disabled={transfer.isPending || del.isPending} onClick={() => setConfirmDelete(true)}>
          delete {d.type}
        </Button>
      )}

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
        body={
          d.type === "bucket" ? (
            <>This permanently deletes the bucket{d.bucket && d.bucket.objects > 0 ? ` and its ${d.bucket.objects} object(s)` : ""}.</>
          ) : (
            <>This permanently tears down its workload{d.type === "database" || d.type === "cache" ? " and data" : ""}.</>
          )
        }
        confirmLabel={`delete ${d.type}`}
        danger
        typeToConfirm={d.name}
        busy={del.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => del.mutate(() => api.remove(d.name, d.type === "bucket"))}
      />
    </div>
  );
}
