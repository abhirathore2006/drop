import type { Db } from "../db/db.ts";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const parseDetail = (v: unknown): Record<string, unknown> | null =>
  v == null ? null : typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : (v as Record<string, unknown>);

/** One audit event to append. `actor` is the principal who performed the action. */
export interface AuditEntry {
  actor: string;
  action: string; // dotted verb, e.g. "site.delete", "user.role.set"
  target?: string | null; // resource name / user email acted upon
  targetType?: string | null; // "site" | "app" | "database" | "user" | "org"
  orgId?: string | null; // owning org of the target, when known
  detail?: Record<string, unknown> | null; // extra structured context
}

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  targetType: string | null;
  orgId: string | null;
  detail: Record<string, unknown> | null;
}

export interface AuditListOpts {
  cursor?: string; // keyset: return rows with id < cursor (newest-first)
  limit?: number;
  actor?: string;
  target?: string;
  action?: string;
}

/** Append-only audit trail. Writes are best-effort at the call site (a failed audit write must
 *  never fail the action it records) — callers wrap `record` so it can't throw the request path. */
export class AuditStore {
  constructor(private db: Db) {}

  /** Append one event. Lowercases actor to match the canonical identity everywhere else. */
  async record(e: AuditEntry): Promise<void> {
    await this.db
      .insertInto("audit_log")
      .values({
        actor: e.actor.toLowerCase(),
        action: e.action,
        target: e.target ?? null,
        target_type: e.targetType ?? null,
        org_id: e.orgId ?? null,
        detail: e.detail ? JSON.stringify(e.detail) : null,
      })
      .execute();
  }

  /** Newest-first keyset page over the trail, with optional actor/target/action filters. */
  async list(opts: AuditListOpts = {}): Promise<{ entries: AuditRecord[]; nextCursor?: string }> {
    const limit = Math.min(opts.limit ?? 100, 1000);
    let q = this.db.selectFrom("audit_log").selectAll().orderBy("id", "desc").limit(limit + 1);
    if (opts.cursor) q = q.where("id", "<", opts.cursor);
    if (opts.actor) q = q.where("actor", "=", opts.actor.toLowerCase());
    if (opts.target) q = q.where("target", "=", opts.target);
    if (opts.action) q = q.where("action", "=", opts.action);
    const rows = await q.execute();
    const page = rows.slice(0, limit);
    const entries = page.map((r) => ({
      id: String(r.id),
      at: iso(r.at),
      actor: r.actor,
      action: r.action,
      target: r.target,
      targetType: r.target_type,
      orgId: r.org_id,
      detail: parseDetail(r.detail),
    }));
    const nextCursor = rows.length > limit ? entries[entries.length - 1]!.id : undefined;
    return { entries, nextCursor };
  }
}
