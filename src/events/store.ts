// (G3) The events store — a per-org alerting/notification incident feed with dedup, plus the per-org
// outbound webhook config + its delivery. Emits are BEST-EFFORT at the call site (a failed event write
// must never fail the deploy/reconcile/quota path it records) — callers wrap `emit`/`resolve` so they
// can't throw the request path (see the `emitEvent` helper in server.ts / the sweeps in bin/api.ts).
//
// Dedup: at most one OPEN (unresolved) incident per (org_id, site_name, kind). A repeat `emit` while one
// is open BUMPS its `detail.count` + `created_at` instead of inserting a new row (so a flapping
// crash-loop or a throttled quota warning is ONE feed entry, not a flood). `resolve(siteName, kind)`
// closes the open row (recovery); a later `emit` after a resolve opens a FRESH incident.
//
// Webhook delivery fires on a STATE TRANSITION only — a newly-opened incident, or a resolve — never on a
// dedup bump (that's the whole point of the throttle). It runs in the background (fire-and-forget); see
// webhook.ts for the at-most-once posture.
import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import type { EventSeverity } from "../db/schema.ts";
import { deliverEvent, type DeliverableEvent, type DeliveryOpts } from "./webhook.ts";

export type { EventSeverity } from "../db/schema.ts";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const parseDetail = (v: unknown): Record<string, unknown> | null =>
  v == null ? null : typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : (v as Record<string, unknown>);

/** One event to emit. `siteName` is omitted/null for org-level events (e.g. a quota warning). */
export interface EmitInput {
  orgId: string;
  siteName?: string | null;
  kind: string;
  severity: EventSeverity;
  title: string;
  detail?: Record<string, unknown> | null;
}

export interface EventRecord {
  id: string;
  orgId: string;
  siteName: string | null;
  kind: string;
  severity: EventSeverity;
  title: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** The webhook config as returned to the store's callers (the raw secret included — the API route masks it). */
export interface WebhookConfig {
  url: string;
  secret: string | null;
  updatedBy: string;
  updatedAt: string;
}

/** Delivery seam — the default posts to the org webhook; tests inject a recorder. Called ONLY on a
 *  state transition (new open / resolve), with the webhook already resolved (null → no webhook set). */
export type Deliver = (target: { url: string; secret: string | null }, event: EventRecord) => Promise<void>;

export interface EventStoreOpts {
  now?: () => Date;
  deliver?: Deliver; // test injection; default = HMAC-signed POST-with-retry (webhook.ts)
  delivery?: DeliveryOpts; // tuning/fetch injection for the DEFAULT deliver
}

function toDeliverable(e: EventRecord): DeliverableEvent {
  return { kind: e.kind, severity: e.severity, title: e.title, siteName: e.siteName, detail: e.detail, createdAt: e.createdAt, resolvedAt: e.resolvedAt };
}

export class EventStore {
  private now: () => Date;
  private deliver: Deliver;
  // In-flight background deliveries — tracked so tests can await them via `flushDeliveries()`. The
  // request path never drains (fire-and-forget); this is purely a test/shutdown convenience.
  private inflight = new Set<Promise<void>>();

  constructor(
    private db: Db,
    opts: EventStoreOpts = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.deliver = opts.deliver ?? ((target, event) => deliverEvent(target, toDeliverable(event), opts.delivery ?? {}).then(() => undefined));
  }

  private toRecord(r: Record<string, unknown>): EventRecord {
    return {
      id: String(r.id),
      orgId: r.org_id as string,
      siteName: (r.site_name as string | null) ?? null,
      kind: r.kind as string,
      severity: r.severity as EventSeverity,
      title: r.title as string,
      detail: parseDetail(r.detail),
      createdAt: iso(r.created_at),
      resolvedAt: isoOrNull(r.resolved_at),
    };
  }

  /** Emit an incident. Dedups to the open row for (org, site, kind): a repeat while open bumps
   *  `detail.count` + `created_at`; otherwise a new open row is inserted. Delivery fires only on a NEW
   *  open incident. Returns the (new or bumped) record. */
  async emit(input: EmitInput): Promise<EventRecord> {
    const site = input.siteName ?? null;
    const now = this.now();
    let base = this.db.selectFrom("events").selectAll().where("org_id", "=", input.orgId).where("kind", "=", input.kind).where("resolved_at", "is", null);
    base = site === null ? base.where("site_name", "is", null) : base.where("site_name", "=", site);
    const open = await base.executeTakeFirst();

    if (open) {
      // Dedup: bump the count + freshen created_at/severity/title (a flapping incident stays ONE row).
      const prev = parseDetail(open.detail) ?? {};
      const count = (typeof prev.count === "number" ? prev.count : 1) + 1;
      const detail = { ...prev, ...(input.detail ?? {}), count };
      await this.db.updateTable("events").set({ created_at: now, severity: input.severity, title: input.title, detail: JSON.stringify(detail) }).where("id", "=", open.id).execute();
      return this.toRecord({ ...open, created_at: now, severity: input.severity, title: input.title, detail });
    }

    const detail = { ...(input.detail ?? {}), count: 1 };
    const inserted = await this.db
      .insertInto("events")
      .values({ org_id: input.orgId, site_name: site, kind: input.kind, severity: input.severity, title: input.title, detail: JSON.stringify(detail), created_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    const rec = this.toRecord(inserted as Record<string, unknown>);
    await this.fire(rec); // deliver on the state transition (new open)
    return rec;
  }

  /** Resolve the open incident for (site, kind) — recovery. No-op (returns null) when none is open.
   *  site names are globally unique, so (site, kind) locates it without needing the org. */
  async resolve(siteName: string, kind: string): Promise<EventRecord | null> {
    const open = await this.db
      .selectFrom("events")
      .selectAll()
      .where("site_name", "=", siteName)
      .where("kind", "=", kind)
      .where("resolved_at", "is", null)
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (!open) return null;
    const now = this.now();
    await this.db.updateTable("events").set({ resolved_at: now }).where("id", "=", open.id).execute();
    const rec = this.toRecord({ ...open, resolved_at: now });
    await this.fire(rec); // deliver the recovery
    return rec;
  }

  /** Newest-first keyset page over an org's events (open + resolved). */
  async list(orgId: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ events: EventRecord[]; nextCursor?: string }> {
    const limit = Math.min(opts.limit ?? 100, 1000);
    let q = this.db.selectFrom("events").selectAll().where("org_id", "=", orgId).orderBy("id", "desc").limit(limit + 1);
    if (opts.cursor) q = q.where("id", "<", opts.cursor);
    const rows = await q.execute();
    const page = rows.slice(0, limit);
    const events = page.map((r) => this.toRecord(r as Record<string, unknown>));
    const nextCursor = rows.length > limit ? events[events.length - 1]!.id : undefined;
    return { events, nextCursor };
  }

  /** Count OPEN, ACTIONABLE (warning/error) incidents across every org the user belongs to — the frame's
   *  unread badge (folded into /v1/me). Membership-scoped: you see incidents for the orgs you're a member
   *  of. `info` notices (e.g. a preview-expiring heads-up) show in the feed but don't badge — they're not
   *  a condition to fix, and they have no recovery signal, so counting them would inflate the badge. */
  async countUnresolvedForUser(email: string): Promise<number> {
    const r = await this.db
      .selectFrom("events")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("resolved_at", "is", null)
      .where("severity", "in", ["warning", "error"])
      .where("org_id", "in", (eb) => eb.selectFrom("org_members").select("org_id").where("email", "=", email.toLowerCase()))
      .executeTakeFirst();
    return r?.n ?? 0;
  }

  /** Count OPEN, actionable (warning/error) incidents for one org (the `?unresolved=1` count). */
  async countUnresolved(orgId: string): Promise<number> {
    const r = await this.db
      .selectFrom("events")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("org_id", "=", orgId)
      .where("resolved_at", "is", null)
      .where("severity", "in", ["warning", "error"])
      .executeTakeFirst();
    return r?.n ?? 0;
  }

  /** Retention sweep: delete events older than `before` (30d default, swept with the G2 rollups). An
   *  actively-flapping incident keeps a fresh created_at (dedup bumps it), so only truly-stale rows go. */
  async sweep(before: Date): Promise<number> {
    const res = await this.db.deleteFrom("events").where("created_at", "<", before).executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n);
  }

  // ---- webhook config -------------------------------------------------------------------------

  async getWebhook(orgId: string): Promise<WebhookConfig | null> {
    const r = await this.db.selectFrom("event_webhooks").selectAll().where("org_id", "=", orgId).executeTakeFirst();
    return r ? { url: r.url, secret: r.secret, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) } : null;
  }

  async setWebhook(orgId: string, url: string, secret: string | null, updatedBy: string): Promise<void> {
    const now = this.now();
    await this.db
      .insertInto("event_webhooks")
      .values({ org_id: orgId, url, secret, updated_by: updatedBy, updated_at: now })
      .onConflict((oc) => oc.column("org_id").doUpdateSet({ url, secret, updated_by: updatedBy, updated_at: now }))
      .execute();
  }

  async deleteWebhook(orgId: string): Promise<void> {
    await this.db.deleteFrom("event_webhooks").where("org_id", "=", orgId).execute();
  }

  /** Await all in-flight background deliveries (tests / graceful shutdown). */
  async flushDeliveries(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  // Look up the org's webhook and (if set) deliver `rec` in the BACKGROUND. Never throws.
  private async fire(rec: EventRecord): Promise<void> {
    let wh: WebhookConfig | null;
    try {
      wh = await this.getWebhook(rec.orgId);
    } catch (e) {
      console.error(`event webhook lookup (${rec.kind}):`, (e as Error).message);
      return;
    }
    if (!wh) return;
    const p = this.deliver({ url: wh.url, secret: wh.secret }, rec)
      .catch((e) => console.error(`event webhook delivery (${rec.kind}):`, (e as Error).message))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }
}
