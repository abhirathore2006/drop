// Preview registry (E1). A preview is a labeled, expiring pointer to a SPECIFIC version, served at
// `<site>--<label>.<baseDomain>` alongside (never instead of) the parent's `current_version`. One
// row per (site_name, label) — re-publishing the same label re-points it at a new version (upsert).
// The edge resolves (site,label) -> version_id read-only; the API's preview routes (folded into
// `POST .../versions?preview=`, plus a dedicated `DELETE .../previews/:label`) are the sole writer;
// the housekeeping sweep (bin/api.ts) is the sole deleter of rows past `expires_at`.
import type { Db } from "../db/db.ts";
import type { PreviewKind } from "../db/schema.ts";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export interface Preview {
  siteName: string;
  label: string;
  versionId: string; // (E1 site) static version id; (E2 app) the deployed image ref
  createdBy: string;
  createdAt: string; // ISO
  expiresAt: string; // ISO
  kind: PreviewKind; // (E2) 'site' | 'app' — the sweep/rm branch on this
  hasDb: boolean; // (E2) app preview owns a --with-db CNPG clone (`<name>-p-<label>-db`)
}

function toPreview(row: Record<string, unknown>): Preview {
  return {
    siteName: row.site_name as string,
    label: row.label as string,
    versionId: row.version_id as string,
    createdBy: row.created_by as string,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    kind: (row.kind as PreviewKind | undefined) ?? "site",
    hasDb: !!row.has_db,
  };
}

// dns-safe, 1-20 chars total (1 + up to 18 middle + 1), no leading/trailing hyphen. Mirrors the
// shape of src/names.ts's LABEL but with a tighter length cap (a preview label is a short suffix,
// not a full resource name).
const LABEL = /^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/;

/** Validate a preview label: dns-safe, 1-20 chars. `--` is rejected explicitly (same reasoning as
 *  src/names.ts's site-name reservation) — LABEL's middle character class permits repeated hyphens,
 *  and allowing "--" here would make the `<site>--<label>` hostname split ambiguous. */
export function validatePreviewLabel(label: string): string | null {
  if (!LABEL.test(label)) {
    return `invalid preview label "${label}": must be a lowercase DNS label, 1-20 chars`;
  }
  if (label.includes("--")) {
    return `invalid preview label "${label}": "--" is reserved (it's the <site>--<label> separator)`;
  }
  return null;
}

export class PreviewStore {
  // `now` is injectable so tests can drive created_at ordering deterministically (two upserts in
  // one test otherwise land in the same clock millisecond) — same pattern as ServiceTokenStore.
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  /** Create or re-point a preview label (upsert on (site_name, label)). `versionId` is a static version
   *  id for a site preview (E1) or the deployed image ref for an app preview (E2). `opts.kind`/`opts.hasDb`
   *  default to a site preview so the E1 publish path keeps calling with the original 5-arg shape. */
  async upsert(
    siteName: string,
    label: string,
    versionId: string,
    createdBy: string,
    expiresAt: Date,
    opts: { kind?: PreviewKind; hasDb?: boolean } = {},
  ): Promise<Preview> {
    const createdAt = this.now();
    const kind = opts.kind ?? "site";
    const hasDb = opts.hasDb ?? false;
    const row = await this.db
      .insertInto("previews")
      .values({ site_name: siteName, label, version_id: versionId, created_by: createdBy, created_at: createdAt, expires_at: expiresAt, kind, has_db: hasDb })
      .onConflict((oc) => oc.columns(["site_name", "label"]).doUpdateSet({ version_id: versionId, created_by: createdBy, created_at: createdAt, expires_at: expiresAt, kind, has_db: hasDb }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPreview(row as Record<string, unknown>);
  }

  /** The live preview row (site, label), or null when it doesn't exist. Callers compare `expiresAt`
   *  themselves against their own clock (the edge's hot-path cache injects its own `now()`). */
  async get(siteName: string, label: string): Promise<Preview | null> {
    const row = await this.db.selectFrom("previews").selectAll().where("site_name", "=", siteName).where("label", "=", label).executeTakeFirst();
    return row ? toPreview(row as Record<string, unknown>) : null;
  }

  /** Every preview for a site, newest first — `drop preview ls` + the console panel. Includes
   *  already-expired-but-not-yet-swept rows (the sweep interval bounds how stale this can get). */
  async listForSite(siteName: string): Promise<Preview[]> {
    const rows = await this.db.selectFrom("previews").selectAll().where("site_name", "=", siteName).orderBy("created_at", "desc").execute();
    return rows.map((r) => toPreview(r as Record<string, unknown>));
  }

  /** Remove one preview (idempotent). Returns true iff a row was actually deleted. */
  async remove(siteName: string, label: string): Promise<boolean> {
    const res = await this.db.deleteFrom("previews").where("site_name", "=", siteName).where("label", "=", label).executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n) > 0;
  }

  /** Every preview whose `expires_at` has passed, WITHOUT deleting (the sweep's first phase). An app
   *  preview (E2) needs its kube manifest set (+ optional db) torn down BEFORE its row is dropped —
   *  reading first, tearing down (idempotent), then deleting keeps a crash mid-sweep from orphaning
   *  the workload: the row survives, so the next sweep re-tears-down and re-deletes. */
  async listExpired(now: Date): Promise<Preview[]> {
    const rows = await this.db.selectFrom("previews").selectAll().where("expires_at", "<", now).execute();
    return rows.map((r) => toPreview(r as Record<string, unknown>));
  }

  /** Delete every preview whose `expires_at` has passed (the housekeeping sweep). Returns the removed
   *  rows (incl. `kind`/`hasDb`) for logging + teardown attribution. For a SITE preview the bytes are
   *  VERSION bytes (the existing publish-time pruneVersions/GC covers them) and this only drops the
   *  POINTER row; for an APP preview the caller (bin/api.ts) also tears down `<name>-p-<label>` (+ db).
   *  No audit event: a sweep is not a user action (consistent with every other time-based cleanup). */
  async deleteExpired(now: Date): Promise<{ siteName: string; label: string; kind: PreviewKind; hasDb: boolean }[]> {
    const rows = await this.db.deleteFrom("previews").where("expires_at", "<", now).returning(["site_name", "label", "kind", "has_db"]).execute();
    return rows.map((r) => ({ siteName: r.site_name as string, label: r.label as string, kind: (r.kind as PreviewKind | undefined) ?? "site", hasDb: !!r.has_db }));
  }

  /** (E2) Count the LIVE app previews (kind='app', unexpired-or-not-yet-swept) across an org — each is a
   *  running workload, so it counts against the org workload cap at create time. Joins previews→sites for
   *  the org (a preview row lives under its parent workload's site, which carries the org). */
  async countAppPreviewsForOrg(orgId: string): Promise<number> {
    const row = await this.db
      .selectFrom("previews")
      .innerJoin("sites", "sites.name", "previews.site_name")
      .where("sites.org_id", "=", orgId)
      .where("previews.kind", "=", "app")
      .select((eb) => eb.fn.countAll().as("n"))
      .executeTakeFirst();
    return Number((row as { n?: unknown } | undefined)?.n ?? 0);
  }
}
