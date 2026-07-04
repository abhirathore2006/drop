// merge into api.ts — kept separate this round because api.ts is owned by a concurrent
// agent. Same-origin fetch carries the session cookie, identical to lib/api.ts's `req`
// (module-private there, so the tiny wrapper is duplicated here on purpose).

import { ApiError, type GraphPlanStep, type Org, type StackGraph, type TemplateSpec } from "./api.ts";
import type { EditorSpec } from "./stack-editor.ts";

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: string }).error ?? `${path}: ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return json as T;
}

/** An org the signed-in user belongs to (GET /v1/orgs — the same list the CLI uses).
 *  `role` is the caller's role in that org. */
export interface OrgSummary {
  slug: string;
  name: string;
  kind: string; // "personal" | "team"
  role: string; // "owner" | "admin" | "member" | "viewer"
}

export interface OrgMember {
  email: string;
  role: string;
}

/** GET /v1/orgs/:slug — the org plus its member roster. */
export interface OrgDetail {
  slug: string;
  name: string;
  kind: string;
  members: OrgMember[];
}

/** A service-account / CI token (J1) as listed in Settings › Tokens. Never carries the secret/hash. */
export interface ServiceToken {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The create response — includes the one-time `token` secret (RevealOnce). */
export interface CreatedToken extends ServiceToken {
  token: string;
}

// ---- Stack editing (C2) — GET the spec to edit, POST it back through the SAME `up` endpoint ----------
/** GET /v1/stacks/:name — the full stored spec + spec_version the editor rebases against, plus the
 *  per-resource live rows. `spec` is exactly what the CLI would edit in drop.yaml (write it back via up). */
export interface StackDetail {
  name: string;
  org?: Org | null;
  specVersion: number;
  fromTemplate: string | null;
  fromTemplateVersion: string | null;
  spec: EditorSpec;
  resources: { key: string; type: string; siteName: string; exists: boolean; url: string; runtimeState: string | null }[];
}

/** POST /v1/stacks/:name/up response. Dry-run carries `dryRun:true` + the plan; execute carries `applied`.
 *  A stale `spec_version` comes back as a 409 (ApiError.status === 409) — the editor rebases + retries. */
export interface StackUpResult {
  stack: string;
  org: string;
  specVersion: number;
  plan: GraphPlanStep[];
  applied?: { action: string; key: string }[];
  needs?: { key: string; kind: string; siteName: string }[];
  outputs?: Record<string, unknown>;
  dryRun?: boolean;
}

// ---- Template upstream diff (D2) — three-way diff + upgrade (merge → standard reconcile) -------------
export type DiffClass = "unchanged" | "upstream-only" | "local-only" | "conflict";
export type DiffBadge = "added" | "removed" | "changed" | "conflict" | "unchanged";
export interface StackFieldDiff {
  field: string;
  class: DiffClass;
  pinned?: unknown;
  latest?: unknown;
  current?: unknown;
}
export interface StackResourceDiff {
  key: string;
  class: string; // unchanged | upstream-only | local-only | conflict | added-upstream | removed-upstream | added-local | removed-local
  conflict: boolean;
  badge: DiffBadge;
  fields: StackFieldDiff[];
  inPinned: boolean;
  inLatest: boolean;
  inCurrent: boolean;
}
export interface StackDiff {
  upstreamChanged: boolean;
  hasLocalDrift: boolean;
  resources: StackResourceDiff[];
  conflicts: string[];
}
/** GET /v1/stacks/:name/outdated. `templateDerived:false` (with a 404 that `req` surfaces as ApiError)
 *  means the stack was not made from a template — the caller just hides the banner. */
export interface OutdatedResult {
  upToDate: boolean;
  templateDerived: boolean;
  template?: string;
  fromVersion?: string;
  latestVersion: string | null;
  diff?: StackDiff;
  current?: TemplateSpec; // the stack's current concrete spec (for the union canvas)
  latest?: TemplateSpec; // the template's latest concrete spec (for the union canvas)
}
/** POST /v1/stacks/:name/upgrade response (extends the standard up result with the version transition). */
export interface UpgradeResult extends StackUpResult {
  template?: string;
  fromVersion?: string;
  toVersion?: string;
  autoApplied?: string[];
  resolved?: { key: string; how: string }[];
}

// ---- Environments (E3) — durable named instantiations with a per-env variable overlay ----------------
/** One named environment (the default env is surfaced separately as `default`). */
export interface EnvSummary {
  name: string;
  variables: Record<string, string>;
  resources: number;
  createdBy: string;
  createdAt: string;
}
/** GET /v1/stacks/:name/environments. `default` is the implicit unnamed env every stack has. */
export interface EnvList {
  stack: string;
  default: { name: "default"; resources: number };
  environments: EnvSummary[];
}

// ---- GitOps link (B3) — pull-only git → stack sync (`drop stack link`) --------------------------------
/** GET /v1/stacks/:name/link. The token is NEVER returned (masked to `hasToken`). `lastStatus` is
 *  'synced' | 'failed' | 'pending_review' (dry-run-only links park changes for a human to apply). */
export interface StackLinkStatus {
  repo: string;
  branch: string;
  path: string;
  dryRunOnly: boolean;
  hasToken: boolean;
  lastSha: string | null;
  lastStatus: "synced" | "failed" | "pending_review" | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  pendingSha: string | null;
  createdBy: string;
  createdAt: string;
}
/** The sync/apply outcome (POST /link/sync + /link/apply both return `{stack, result, link}`). */
export interface StackLinkSyncResult {
  outcome: "unchanged" | "synced" | "pending_review" | "failed";
  sha?: string;
  error?: string;
  specVersion?: number;
  changedSinceReview?: boolean;
}

/** (F2) GET /v1/features — the console's capability probe. `llmEnabled` gates the AI-intent prompt box.
 *  Lives here (not on the `Me` type in api.ts, owned by another agent) as a tiny dedicated endpoint. */
export interface Features {
  llmEnabled: boolean;
}

/** (F2) POST /v1/stacks/generate response — a PROPOSED, unapplied stack spec (sanitized server-side) plus
 *  optional AI/edge-review notes. The spec loads into the C2 editor as pending changes; it is NEVER applied
 *  by this call — the human reviews on the canvas, then Apply → dry-run → confirm → execute. */
export interface GeneratedStack {
  spec: EditorSpec;
  notes?: string[];
}

export const apiExtra = {
  /** The stack's editable spec + spec_version (C2 editor bootstrap). */
  stackDetail: (name: string) => req<StackDetail>("GET", `/v1/stacks/${encodeURIComponent(name)}`),
  // ---- (F2) AI intent ----
  /** Which optional features this deployment has enabled (AI intent probe). Retry off + treat a 404/501 as
   *  "off" so an older API or a disabled feature simply hides the prompt box. */
  features: () => req<Features>("GET", "/v1/features"),
  /** Turn a natural-language prompt into a PROPOSED stack spec. Returns the sanitized spec + notes; the spec
   *  is NEVER executed here — it seeds the C2 editor as pending changes for human review before Apply. */
  generateStack: (prompt: string, org?: string) => req<GeneratedStack>("POST", "/v1/stacks/generate", { prompt, ...(org ? { org } : {}) }),
  // ---- Environments (E3) ----
  /** The C1 graph scoped to an environment ('' / "default" = the default env). Mirrors api.stackGraph
   *  but adds the `?env=` scope (api.ts is owned by a concurrent agent, so the env variant lives here). */
  stackGraph: (name: string, env?: string) => {
    const base = `/v1/stacks/${encodeURIComponent(name)}/graph`;
    const q = env && env !== "default" ? `?include_plan=1&env=${encodeURIComponent(env)}` : "?include_plan=1";
    return req<StackGraph>("GET", base + q);
  },
  /** List a stack's environments (named + the implicit default). */
  stackEnvironments: (name: string) => req<EnvList>("GET", `/v1/stacks/${encodeURIComponent(name)}/environments`),
  /** Create a named environment with an optional variable overlay. */
  createEnvironment: (name: string, env: string, variables: Record<string, string>) =>
    req<{ stack: string; env: string; variables: Record<string, string> }>("POST", `/v1/stacks/${encodeURIComponent(name)}/environments`, { env, variables }),
  /** Delete an environment; `cascade` also tears down its resources. */
  deleteEnvironment: (name: string, env: string, cascade = false) =>
    req<{ stack: string; deleted: string }>("DELETE", `/v1/stacks/${encodeURIComponent(name)}/environments/${encodeURIComponent(env)}${cascade ? "?cascade=1" : ""}`),
  /** Promote <source>'s applied spec into <target> (images pinned exact; target keeps its own variables). */
  promoteEnvironment: (name: string, source: string, to: string) =>
    req<StackUpResult & { from: string; to: string }>("POST", `/v1/stacks/${encodeURIComponent(name)}/environments/${encodeURIComponent(source || "default")}/promote`, { to }),
  // ---- GitOps link (B3) ----
  /** The stack's GitOps link + last-sync state (null when unlinked). Token always masked server-side. */
  stackLink: (name: string) => req<{ stack: string; link: StackLinkStatus | null }>("GET", `/v1/stacks/${encodeURIComponent(name)}/link`),
  /** Sync now — the poller's tick on demand. A dry-run-only link parks the change as pending_review. */
  stackLinkSync: (name: string) => req<{ stack: string; result: StackLinkSyncResult; link: StackLinkStatus | null }>("POST", `/v1/stacks/${encodeURIComponent(name)}/link/sync`, {}),
  /** Apply the REVIEWED pending change (dry-run-only mode). 409 if the file moved since review. */
  stackLinkApply: (name: string) => req<{ stack: string; result: StackLinkSyncResult; link: StackLinkStatus | null }>("POST", `/v1/stacks/${encodeURIComponent(name)}/link/apply`, {}),
  /** (D2) Three-way diff of the stack vs its template's latest version. 404 → not template-derived. */
  stackOutdated: (name: string) => req<OutdatedResult>("GET", `/v1/stacks/${encodeURIComponent(name)}/outdated`),
  /** (D2) Apply upstream changes. `dry_run` returns the reconcile plan; a missing conflict resolution 409s. */
  stackUpgrade: (name: string, body: { to?: string; resolutions?: Record<string, "take-upstream" | "keep-local"> }, dryRun = false) =>
    req<UpgradeResult>("POST", `/v1/stacks/${encodeURIComponent(name)}/upgrade${dryRun ? "?dry_run=1" : ""}`, body),
  /** Reconcile an edited spec: `dry_run` returns the plan (safe), otherwise it executes. `prune` opts in
   *  to actually removing flagged deletes (default false → deletes are flagged-only). Optimistic-locked
   *  by `spec_version`; a mismatch is a 409. Identical contract to `drop up`. */
  stackUp: (name: string, body: { spec: EditorSpec; prune?: boolean; spec_version?: number }, dryRun = false) =>
    req<StackUpResult>("POST", `/v1/stacks/${encodeURIComponent(name)}/up${dryRun ? "?dry_run=1" : ""}`, body),
  /** The signed-in user's orgs (personal + any team orgs). Powers the org switcher. */
  orgs: () => req<{ orgs: OrgSummary[] }>("GET", "/v1/orgs"),
  /** One org with its members — the Settings › Members panel. */
  orgDetail: (slug: string) => req<OrgDetail>("GET", `/v1/orgs/${encodeURIComponent(slug)}`),
  // ---- org membership (M2) — owner/admin only (server-enforced via canManageOrg) ----
  addMember: (slug: string, email: string, role: string) => req<{ slug: string; email: string; role: string }>("POST", `/v1/orgs/${encodeURIComponent(slug)}/members`, { email, role }),
  removeMember: (slug: string, email: string) => req<{ removed: string }>("DELETE", `/v1/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(email)}`),
  /** Change an existing member's role. "owner" is not assignable (single-owner invariant). */
  setMemberRole: (slug: string, email: string, role: string) => req<{ slug: string; email: string; role: string }>("PATCH", `/v1/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(email)}`, { role }),
  /** The CLI/API version this instance serves — the user-menu version chip. */
  version: () => req<{ version: string }>("GET", "/version"),
  // ---- service accounts / scoped CI tokens (J1) — Settings › Tokens ----
  tokens: (slug: string) => req<{ tokens: ServiceToken[] }>("GET", `/v1/orgs/${encodeURIComponent(slug)}/tokens`),
  createToken: (slug: string, name: string, scopes: string[], expiresDays?: number) =>
    req<CreatedToken>("POST", `/v1/orgs/${encodeURIComponent(slug)}/tokens`, { name, scopes, ...(expiresDays ? { expires_days: expiresDays } : {}) }),
  revokeToken: (slug: string, id: string) => req<{ revoked: string; name: string }>("DELETE", `/v1/orgs/${encodeURIComponent(slug)}/tokens/${encodeURIComponent(id)}`),
};

/** The permission verbs a token scope may use (mirrors src/authz/permissions.ts ACTIONS). Kept here
 *  so the scope builder's verb <select> stays a static list — the server is the source of truth and
 *  rejects anything unknown with a clear 400. */
export const TOKEN_VERBS = ["read", "logs", "publish", "deploy", "db:create", "rollback", "configure", "expose", "share", "transfer", "delete"] as const;
