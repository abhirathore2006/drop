// (B3) The per-stack GitOps sync — ONE function both the housekeeping poller (bin/api.ts) and the
// manual `POST /v1/stacks/:name/link/sync` / `/link/apply` routes call, so a poll tick and a
// "sync now" click are byte-identical. Flow:
//
//   fetch the linked file → content sha256 (change detection — provider-agnostic; see fetch.ts)
//     unchanged → no-op
//     changed   → parse the drop.yaml `stack:` section → run the STANDARD stack up via the injected
//                 `reconcile` (server.ts's reconcileStack, which takes the stack's advisory lock
//                 `stack:<id>` itself — the exact same lock every other `up` path serializes on, so a
//                 GitOps apply can never interleave with a CLI/console up; a held lock surfaces as a
//                 clean 409-failure and the next poll retries) → record last_sha/last_status/last_synced_at.
//
// Failures land in the G3 events feed (`gitops_failed`, deduped per stack; a later success resolves it
// and emits `gitops_synced`). The reconcile runs on the DEFAULT env with the link creator's identity —
// their authz at sync time gates the apply (if they lose rights, syncs fail honestly).
//
// Spec-only v1: a spec with `dir:` build contexts is REFUSED with a clear last_error — the poller has
// no CLI to build/publish content, so GitOps covers image-pinned specs only. Full source-build-on-push
// composes later with Future.md item 8 step 3 (in-cluster builds).
//
// `--dry-run-only` mode: a sha change does NOT auto-apply — it parks as last_status='pending_review' +
// pending_sha; the console/CLI apply action re-runs this function in "apply" mode, which re-fetches and
// verifies the content still matches the reviewed sha (moved content re-parks for a fresh review).
import type { EmitInput } from "../events/store.ts";
import type { Org } from "../orgs/store.ts";
import type { StackRow } from "../stacks/store.ts";
import { parseStackConfig, type StackSpec } from "../stack-config.ts";
import { fetchStackFile, type FetchLike } from "./fetch.ts";
import type { StackLinkRow, StackLinkStore } from "./store.ts";

/** The reconcile args the sync hands to server.ts's reconcileStack (already parsed + sanitized). */
export interface GitopsReconcileArgs {
  name: string;
  org: Org;
  spec: StackSpec;
  prune: boolean;
  dryRun: boolean;
  env: string;
  variables: Record<string, string>;
  auditAction: string;
  auditDetail: Record<string, unknown>;
}

/** server.ts wires this to `reconcileStack` bound to the given actor's identity (the link creator). */
export type GitopsReconcile = (actorEmail: string, args: GitopsReconcileArgs) => Promise<{ status: number; body: Record<string, unknown> }>;

export interface GitopsSyncDeps {
  links: StackLinkStore;
  getOrg: (orgId: string) => Promise<Org | null>;
  reconcile: GitopsReconcile;
  /** Best-effort G3 emitter — the caller wraps EventStore.emit so it can't throw the sync path. */
  emit: (e: EmitInput) => Promise<unknown> | unknown;
  /** Best-effort G3 resolver — closes the open `gitops_failed` incident on recovery. */
  resolve: (siteName: string, kind: string) => Promise<unknown> | unknown;
  fetchImpl?: FetchLike; // test injection — tests never hit the network
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
}

export interface GitopsSyncOpts {
  /** "poll" (default) honours dry_run_only + the unchanged-sha no-op; "apply" executes the reviewed
   *  pending change (must still match `expectSha`, else it re-parks for a fresh review). */
  mode?: "poll" | "apply";
  expectSha?: string;
}

export interface GitopsSyncResult {
  outcome: "unchanged" | "synced" | "pending_review" | "failed";
  sha?: string;
  error?: string;
  specVersion?: number;
  /** apply-mode only: the fetched content no longer matches the reviewed sha — re-parked, not applied. */
  changedSinceReview?: boolean;
}

/** The wired runner shape server.ts hands to bin/api.ts via Deps.onGitopsSync. */
export type GitopsSyncRunner = (stack: StackRow, link: StackLinkRow, opts?: GitopsSyncOpts) => Promise<GitopsSyncResult>;

export async function syncLinkedStack(deps: GitopsSyncDeps, stack: StackRow, link: StackLinkRow, opts: GitopsSyncOpts = {}): Promise<GitopsSyncResult> {
  const now = deps.now ?? (() => new Date());
  const mode = opts.mode ?? "poll";

  // Record the failure + emit the (deduped) G3 incident. The error strings are token-free by
  // construction (fetch.ts) / server-authored (reconcile body) — safe for the feed + last_error.
  const fail = async (error: string, sha?: string): Promise<GitopsSyncResult> => {
    await deps.links.updateSyncState(stack.id, { lastStatus: "failed", lastError: error });
    await deps.emit({
      orgId: stack.orgId,
      siteName: stack.name,
      kind: "gitops_failed",
      severity: "error",
      title: `gitops sync failed: ${stack.name}`,
      detail: { repo: link.repo, branch: link.branch, path: link.path, ...(sha ? { sha } : {}), error },
    });
    return { outcome: "failed", error, ...(sha ? { sha } : {}) };
  };

  let fetched: { sha: string; content: string };
  try {
    fetched = await fetchStackFile(
      { repo: link.repo, branch: link.branch, path: link.path, ...(link.token ? { token: link.token } : {}) },
      { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, maxBytes: deps.maxBytes },
    );
  } catch (e) {
    return fail((e as Error).message);
  }
  const sha = fetched.sha;

  // Change detection: the content sha256 vs the last APPLIED sha. Unchanged → nothing to do. (A failed
  // sync never advances last_sha, so the next tick retries the same content until it applies.)
  if (mode === "poll" && sha === link.lastSha) return { outcome: "unchanged", sha };

  // Dry-run-only gate: park the change for human review instead of applying (requirement: the console
  // confirm action applies it). Re-parking the SAME sha is a no-write no-op.
  if (mode === "poll" && link.dryRunOnly) {
    if (link.pendingSha !== sha || link.lastStatus !== "pending_review") {
      await deps.links.updateSyncState(stack.id, { pendingSha: sha, lastStatus: "pending_review", lastError: null });
    }
    return { outcome: "pending_review", sha };
  }

  // Apply-mode integrity: the file must still be the bytes the human reviewed. Moved content re-parks
  // under the NEW sha for a fresh review — never apply unreviewed bytes.
  if (mode === "apply" && opts.expectSha && sha !== opts.expectSha) {
    await deps.links.updateSyncState(stack.id, { pendingSha: sha, lastStatus: "pending_review", lastError: null });
    return { outcome: "pending_review", sha, changedSinceReview: true };
  }

  const spec = parseStackConfig(fetched.content);
  if (!spec) return fail(`${link.path} has no valid stack: section (needs a name and at least one resource)`, sha);
  if (spec.name !== stack.name) return fail(`spec stack name "${spec.name}" does not match the linked stack "${stack.name}"`, sha);

  // Spec-only v1: `dir:` build contexts need a CLI to build images / publish site bytes — the poller has
  // neither. Refuse with a clear error; in-cluster builds (Future.md item 8 step 3) lift this later.
  const dirKeys = Object.entries(spec.resources)
    .filter(([, r]) => !!r.dir)
    .map(([k]) => k);
  if (dirKeys.length) {
    return fail(`spec-only GitOps v1: resource(s) ${dirKeys.join(", ")} use dir: build contexts — pin images by ref for GitOps (source builds compose later with in-cluster builds)`, sha);
  }

  const org = await deps.getOrg(stack.orgId);
  if (!org) return fail(`stack organisation ${stack.orgId} no longer exists`, sha);

  // The STANDARD up (reconcileStack) — it takes the `stack:<id>` advisory lock internally, audits
  // `stack.sync` (the injected auditAction), and enforces the link creator's authz per resource.
  const r = await deps.reconcile(link.createdBy, {
    name: stack.name,
    org,
    spec,
    prune: false, // removed resources are flagged, never auto-torn-down by a pull (same default as `drop up`)
    dryRun: false,
    env: "", // GitOps authors the DEFAULT env (named envs re-resolve the shared spec with their own vars)
    variables: {},
    auditAction: "stack.sync",
    auditDetail: { gitops: true, repo: link.repo, branch: link.branch, path: link.path, sha, ...(mode === "apply" ? { reviewed: true } : {}) },
  });
  if (r.status !== 200) {
    return fail(typeof r.body.error === "string" ? r.body.error : `stack up returned ${r.status}`, sha);
  }

  await deps.links.updateSyncState(stack.id, { lastSha: sha, lastStatus: "synced", lastError: null, lastSyncedAt: now(), pendingSha: null });
  await deps.resolve(stack.name, "gitops_failed"); // recovery: a clean sync closes any open failure incident
  const specVersion = typeof r.body.specVersion === "number" ? r.body.specVersion : undefined;
  await deps.emit({
    orgId: stack.orgId,
    siteName: stack.name,
    kind: "gitops_synced",
    severity: "info",
    title: `gitops synced: ${stack.name}`,
    detail: { repo: link.repo, branch: link.branch, path: link.path, sha, ...(specVersion != null ? { specVersion } : {}) },
  });
  return { outcome: "synced", sha, ...(specVersion != null ? { specVersion } : {}) };
}
