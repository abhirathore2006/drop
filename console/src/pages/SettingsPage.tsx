// Org settings (M1) — a per-org frame scoped to the ?org context. Members and usage/quota
// are wired to existing endpoints; tokens and webhooks are honest placeholders for the
// slices that build them.
//
// J1: the Tokens tab — service-account / scoped CI tokens (create with a scope picker,
//     RevealOnce the secret, last-used, revoke) — lands with J1.
// G3: the Webhooks tab — per-org outbound webhook (Slack/Teams incoming-webhook URL) for
//     the events feed — lands with G3.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { useOrgsQuery } from "../components/OrgSwitcher.tsx";
import { apiExtra, type OrgSummary } from "../lib/api-extra.ts";
import { api } from "../lib/api.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { currentOrg, useOrgParam } from "../lib/org.ts";

type SettingsTab = "members" | "usage" | "tokens" | "webhooks";

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function SettingsPage() {
  useDocumentTitle("settings · drop");
  const [param] = useOrgParam();
  const org = currentOrg(useOrgsQuery().data?.orgs, param);
  const [tab, setTab] = useState<SettingsTab>("members");

  if (!org) {
    return (
      <section>
        <h2>Settings</h2>
        <EmptyState title="Pick an org.">Settings are per-org — choose one from the switcher in the sidebar.</EmptyState>
      </section>
    );
  }

  return (
    <section>
      <h2>Settings · {org.kind === "personal" ? "personal" : org.name}</h2>
      <Tabs
        tabs={[
          { id: "members", label: "members" },
          { id: "usage", label: "usage" },
          { id: "tokens", label: "tokens" },
          { id: "webhooks", label: "webhooks" },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === "members" ? <Members org={org} /> : tab === "usage" ? <Usage org={org} /> : tab === "tokens" ? <TokensStub /> : <WebhooksStub />}
    </section>
  );
}

function Members({ org }: { org: OrgSummary }) {
  const q = useQuery({ queryKey: ["/v1/orgs", org.slug], queryFn: () => apiExtra.orgDetail(org.slug), staleTime: 30_000 });
  if (q.isPending) return <Skeleton lines={3} />;
  if (q.isError) return <div className="err">{q.error.message}</div>;
  const members = q.data.members;
  return (
    <div className="panels">
      <div className="sec">
        <div className="sec-h">
          <h3>members</h3>
        </div>
        {members.length === 0 ? (
          <p className="muted">
            {org.kind === "personal" ? "Your personal org — it's just you. Create a team org to collaborate." : "No members yet."}
          </p>
        ) : (
          members.map((m) => (
            <div className="item" key={m.email}>
              <div className="meta">
                <b>{m.email}</b>
              </div>
              <span className="pill pill-idle">{m.role}</span>
            </div>
          ))
        )}
        {/* Add/remove members exists at POST/DELETE /v1/orgs/:slug/members; the write UI
            arrives with M2's permission-aware surfaces (owner/admin-gated). */}
      </div>
    </div>
  );
}

function Usage({ org }: { org: OrgSummary }) {
  const q = useQuery({ queryKey: ["/v1/orgs", org.slug, "usage"], queryFn: () => api.orgUsage(org.slug), staleTime: 30_000 });
  if (q.isPending) return <Skeleton lines={4} />;
  if (q.isError) return <div className="err">{q.error.message}</div>;
  const u = q.data;
  return (
    <div className="panels">
      <div className="sec">
        <div className="sec-h">
          <h3>workloads</h3>
        </div>
        <div className="kv">
          <span className="k">total</span>
          <span className="v">
            <b>{u.workloads.total}</b>
            {u.cap > 0 ? ` / ${u.cap} cap` : " (unlimited)"}
          </span>
        </div>
        <div className="kv">
          <span className="k">by type</span>
          <span className="v">
            {u.workloads.app} apps · {u.workloads.database} dbs · {u.workloads.bucket} buckets · {u.workloads.site} sites
          </span>
        </div>
      </div>

      {u.quota && (
        <div className="sec">
          <div className="sec-h">
            <h3>cluster quota</h3>
          </div>
          <div className="kv">
            <span className="k">cpu</span>
            <span className="v">
              {u.quota.used["limits.cpu"] ?? "0"} / {u.quota.hard["limits.cpu"] ?? "—"}
            </span>
          </div>
          <div className="kv">
            <span className="k">memory</span>
            <span className="v">
              {u.quota.used["limits.memory"] ?? "0"} / {u.quota.hard["limits.memory"] ?? "—"}
            </span>
          </div>
          <div className="kv">
            <span className="k">pods</span>
            <span className="v">
              {u.quota.used["count/pods"] ?? "0"} / {u.quota.hard["count/pods"] ?? "—"}
            </span>
          </div>
        </div>
      )}

      {u.storage && (
        <div className="sec">
          <div className="sec-h">
            <h3>storage</h3>
          </div>
          <div className="kv">
            <span className="k">databases</span>
            <span className="v">
              {u.storage.databases.count} · {fmtBytes(u.storage.databases.requestedBytes)} requested
            </span>
          </div>
          <div className="kv">
            <span className="k">buckets</span>
            <span className="v">
              {u.storage.buckets.count} · {fmtBytes(u.storage.buckets.bytes)} stored
            </span>
          </div>
          <div className="kv">
            <span className="k">budget</span>
            <span className="v">{u.storage.budget != null ? fmtBytes(u.storage.budget) : "no budget set"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TokensStub() {
  // J1: service-account / CI tokens.
  return <EmptyState title="Tokens arrive with service accounts.">Scoped CI tokens — create, reveal once, see last-used, revoke — land with J1.</EmptyState>;
}

function WebhooksStub() {
  // G3: outbound org webhook for the events feed.
  return <EmptyState title="Webhooks arrive with events.">A per-org outbound webhook (point it at a Slack or Teams incoming URL) lands with the G3 events feed.</EmptyState>;
}
