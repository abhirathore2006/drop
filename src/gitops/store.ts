// (B3) The seam over `stack_links` — a stack's GitOps link (repo/branch/path + private-repo token) and
// the sync state the poller maintains. CRUD + a partial sync-state update only; the fetch lives in
// fetch.ts (pure-ish, injectable transport) and the per-stack sync in sync.ts — mirroring how
// StackStore/plan.ts split. The `token` column is WRITE-ONLY at the API surface: the routes never
// return it (GET /link masks it to `hasToken`), it exists on the row solely so the poller can send the
// provider auth header (the event_webhooks.secret precedent for a platform-side credential).
import { sql } from "kysely";
import type { Db } from "../db/db.ts";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

export type StackLinkStatus = "synced" | "failed" | "pending_review";

/** One stack's GitOps link row (token INCLUDED — callers above the store must mask it). */
export interface StackLinkRow {
  stackId: string;
  repo: string;
  branch: string;
  path: string;
  token: string | null;
  lastSha: string | null;
  lastStatus: StackLinkStatus | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  pendingSha: string | null;
  dryRunOnly: boolean;
  createdBy: string;
  createdAt: string;
}

/** Partial sync-state patch — only the provided keys are written (explicit null clears a column). */
export interface SyncStatePatch {
  lastSha?: string | null;
  lastStatus?: StackLinkStatus | null;
  lastError?: string | null;
  lastSyncedAt?: Date | string | null;
  pendingSha?: string | null;
}

export class StackLinkStore {
  constructor(private db: Db) {}

  private toRow(r: Record<string, unknown>): StackLinkRow {
    return {
      stackId: r.stack_id as string,
      repo: r.repo as string,
      branch: r.branch as string,
      path: r.path as string,
      token: (r.token as string | null) ?? null,
      lastSha: (r.last_sha as string | null) ?? null,
      lastStatus: (r.last_status as StackLinkStatus | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      lastSyncedAt: isoOrNull(r.last_synced_at),
      pendingSha: (r.pending_sha as string | null) ?? null,
      dryRunOnly: r.dry_run_only === true,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at),
    };
  }

  /** Create-or-replace the stack's link. RE-linking overwrites the config AND resets the sync state
   *  (fresh last_sha/status/pending), so the first poll after a re-link re-fetches and re-applies —
   *  the honest semantics for "point this stack somewhere else". */
  async link(opts: { stackId: string; repo: string; branch: string; path: string; token: string | null; dryRunOnly: boolean; createdBy: string }): Promise<StackLinkRow> {
    const values = {
      stack_id: opts.stackId,
      repo: opts.repo,
      branch: opts.branch,
      path: opts.path,
      token: opts.token,
      dry_run_only: opts.dryRunOnly,
      created_by: opts.createdBy.toLowerCase(),
      last_sha: null,
      last_status: null,
      last_error: null,
      last_synced_at: null,
      pending_sha: null,
    };
    const r = await this.db
      .insertInto("stack_links")
      .values({ ...values, created_at: sql`now()` })
      .onConflict((oc) => oc.column("stack_id").doUpdateSet({ ...values, created_at: sql`now()` }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toRow(r as Record<string, unknown>);
  }

  async get(stackId: string): Promise<StackLinkRow | null> {
    const r = await this.db.selectFrom("stack_links").selectAll().where("stack_id", "=", stackId).executeTakeFirst();
    return r ? this.toRow(r as Record<string, unknown>) : null;
  }

  /** Remove the link (stop polling; nothing else is torn down). Returns false when none existed. */
  async unlink(stackId: string): Promise<boolean> {
    const res = await this.db.deleteFrom("stack_links").where("stack_id", "=", stackId).executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n) > 0;
  }

  /** Every link, in a stable order — the poller's sweep set (bounded: one row per linked stack). */
  async list(): Promise<StackLinkRow[]> {
    const rows = await this.db.selectFrom("stack_links").selectAll().orderBy("stack_id").execute();
    return rows.map((r) => this.toRow(r as Record<string, unknown>));
  }

  /** Write ONLY the provided sync-state keys (explicit null clears; absent keys are untouched). */
  async updateSyncState(stackId: string, patch: SyncStatePatch): Promise<void> {
    const set: Record<string, unknown> = {};
    if ("lastSha" in patch) set.last_sha = patch.lastSha;
    if ("lastStatus" in patch) set.last_status = patch.lastStatus;
    if ("lastError" in patch) set.last_error = patch.lastError;
    if ("lastSyncedAt" in patch) set.last_synced_at = patch.lastSyncedAt;
    if ("pendingSha" in patch) set.pending_sha = patch.pendingSha;
    if (Object.keys(set).length === 0) return;
    await this.db.updateTable("stack_links").set(set).where("stack_id", "=", stackId).execute();
  }
}
