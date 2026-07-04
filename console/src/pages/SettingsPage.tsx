// Org settings (M1) — a per-org frame scoped to the ?org context. Members and usage/quota
// are wired to existing endpoints; tokens and webhooks are honest placeholders for the
// slices that build them.
//
// J1: the Tokens tab — service-account / scoped CI tokens (create with a scope builder,
//     RevealOnce the secret, last-used, revoke; owner/admin-gated) — implemented below.
// G3: the Webhooks tab — per-org outbound webhook (Slack/Teams incoming-webhook URL) for
//     the events feed — lands with G3.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { RevealOnce } from "../components/RevealOnce.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { useToast } from "../components/Toast.tsx";
import { useOrgsQuery } from "../components/OrgSwitcher.tsx";
import { apiExtra, TOKEN_VERBS, type CreatedToken, type OrgSummary, type ServiceToken } from "../lib/api-extra.ts";
import { api, fmtStamp } from "../lib/api.ts";
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
      {tab === "members" ? <Members org={org} /> : tab === "usage" ? <Usage org={org} /> : tab === "tokens" ? <Tokens org={org} /> : <WebhooksStub />}
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

// J1: service-account / scoped CI tokens. Owner/admin-gated (hidden otherwise): a scope builder
// (verb select + optional resource, add/remove rows) creates a token, the secret is RevealOnce'd,
// and each token can be revoked behind a ConfirmDialog. Mirrors the server authz (canManageOrg).
interface ScopeRow {
  verb: string;
  resource: string;
}

/** Compact display state for a token row: revoked > expired > active. */
function tokenState(t: ServiceToken): { label: string; cls: string } {
  if (t.revokedAt) return { label: "revoked", cls: "pill-danger" };
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now()) return { label: "expired", cls: "pill-warn" };
  return { label: "active", cls: "pill-ok" };
}

export function Tokens({ org }: { org: OrgSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = org.role === "owner" || org.role === "admin";

  const q = useQuery({
    queryKey: ["/v1/orgs", org.slug, "tokens"],
    queryFn: () => apiExtra.tokens(org.slug),
    enabled: canManage,
    staleTime: 15_000,
  });

  const [name, setName] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [rows, setRows] = useState<ScopeRow[]>([{ verb: "deploy", resource: "" }]);
  const [secret, setSecret] = useState<CreatedToken | null>(null);
  const [revoking, setRevoking] = useState<ServiceToken | null>(null);

  const create = useMutation({
    mutationFn: () => {
      // A blank resource means "all resources" (bare verb); a value qualifies it as verb:resource.
      const scopes = rows.map((r) => (r.resource.trim() ? `${r.verb}:${r.resource.trim()}` : r.verb));
      const days = expiresDays.trim() ? Number(expiresDays.trim()) : undefined;
      return apiExtra.createToken(org.slug, name.trim(), scopes, days);
    },
    onSuccess: async (res) => {
      setSecret(res); // RevealOnce until the user dismisses it
      setName("");
      setExpiresDays("");
      setRows([{ verb: "deploy", resource: "" }]);
      await qc.invalidateQueries({ queryKey: ["/v1/orgs", org.slug, "tokens"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiExtra.revokeToken(org.slug, id),
    onSuccess: async (r) => {
      toast.success(`revoked ${r.name}`);
      setRevoking(null);
      await qc.invalidateQueries({ queryKey: ["/v1/orgs", org.slug, "tokens"] });
    },
    onError: (e) => {
      toast.error((e as Error).message);
      setRevoking(null);
    },
  });

  if (!canManage) {
    return <EmptyState title="Owner/admin only.">Only an org owner or admin can create and manage service-account tokens.</EmptyState>;
  }

  const nameOk = name.trim().length > 0;
  const scopesOk = rows.length > 0 && rows.every((r) => r.verb);
  const setRow = (i: number, patch: Partial<ScopeRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="panels">
      <div className="sec">
        <div className="sec-h">
          <h3>create a token</h3>
        </div>
        {/* The secret is shown ONCE here — never fetched again. */}
        {secret && (
          <div className="item" style={{ display: "block" }}>
            <div className="meta">
              <b>{secret.name}</b> <span className="muted">— {secret.scopes.join(", ")}</span>
            </div>
            <RevealOnce
              value={secret.token}
              note="shown once — copy it now and store it as DROP_TOKEN in your CI."
              onDismiss={() => setSecret(null)}
            />
          </div>
        )}
        <div className="field">
          <input
            className="input"
            placeholder="name (e.g. ci-deploy)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {rows.map((r, i) => (
          <div className="item visrow" key={i}>
            <select className="input" value={r.verb} onChange={(e) => setRow(i, { verb: e.target.value })} aria-label="verb">
              {TOKEN_VERBS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <input
              className="input"
              placeholder="resource (blank = all)"
              value={r.resource}
              onChange={(e) => setRow(i, { resource: e.target.value })}
              aria-label="resource"
            />
            <Button size="sm" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs))} disabled={rows.length <= 1}>
              remove
            </Button>
          </div>
        ))}
        <div className="field" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <Button size="sm" onClick={() => setRows((rs) => [...rs, { verb: "deploy", resource: "" }])}>
            + scope
          </Button>
          <input
            className="input"
            style={{ maxWidth: "10rem" }}
            placeholder="expires (days, optional)"
            inputMode="numeric"
            value={expiresDays}
            onChange={(e) => setExpiresDays(e.target.value.replace(/[^0-9]/g, ""))}
            aria-label="expires in days"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!nameOk || !scopesOk}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            create token
          </Button>
        </div>
        <p className="sub">Scopes reuse the permission verbs; a blank resource means every resource. Tokens can never touch admin or org-management surfaces.</p>
      </div>

      <div className="sec">
        <div className="sec-h">
          <h3>tokens</h3>
        </div>
        {q.isPending ? (
          <Skeleton lines={3} />
        ) : q.isError ? (
          <div className="err">{q.error.message}</div>
        ) : q.data.tokens.length === 0 ? (
          <p className="muted">No tokens yet — create one above for CI or automation.</p>
        ) : (
          q.data.tokens.map((t) => {
            const st = tokenState(t);
            return (
              <div className="item" key={t.id}>
                <div className="meta">
                  <b>{t.name}</b>
                  <div className="sub">{t.scopes.join(", ")}</div>
                  <div className="sub muted">
                    last used {fmtStamp(t.lastUsedAt)} · expires {t.expiresAt ? fmtStamp(t.expiresAt) : "never"}
                  </div>
                </div>
                <span className={`pill ${st.cls}`}>{st.label}</span>
                {!t.revokedAt && (
                  <Button size="sm" variant="danger" onClick={() => setRevoking(t)}>
                    revoke
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.name ?? ""}?`}
        body={<p>This token stops authenticating immediately. Anything using it (CI) will start failing. This can't be undone.</p>}
        confirmLabel="revoke token"
        danger
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        onCancel={() => setRevoking(null)}
      />
    </div>
  );
}

function WebhooksStub() {
  // G3: outbound org webhook for the events feed.
  return <EmptyState title="Webhooks arrive with events.">A per-org outbound webhook (point it at a Slack or Teams incoming URL) lands with the G3 events feed.</EmptyState>;
}
