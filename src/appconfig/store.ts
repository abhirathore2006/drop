// (L4) Runtime config / feature flags — the single seam over the `app_configs` table.
//
// Deliberately small: a per-app, NON-SECRET key/value store, NOT a flag platform. It exists so flipping a
// flag or tweaking a knob doesn't need a redeploy. Values are non-secret BY DEFINITION — the store
// size-caps them and REFUSES credential-looking values (the D1 heuristic, mirrored below): secrets belong
// in the write-only secret path (`drop secrets set`), never here (they'd be readable in plaintext by the
// console + anyone who can read config).
//
// The `version` is a per-app MONOTONIC ETag. Each mutation computes `next = MAX(version)+1` over the app's
// rows and stamps the mutated row with it; the app-level version = MAX(version). A `set` naturally makes
// its own row the new MAX. A `rm` is the subtle case: deleting a NON-highest row would leave MAX unchanged
// while the content changed (a false 304 on the next poll) — so after a delete that removed a row, we bump
// the highest SURVIVING row to `next`, guaranteeing MAX advances. When the last row is deleted the app
// version resets to 0 (an empty app), which is safe: any prior non-zero ETag differs, so no false 304.
import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import { ConfigValidationError, MAX_VALUE_BYTES, looksLikeSecret, validateConfigKey } from "./validate.ts";

// Re-export the pure validators so store consumers (server.ts, tests) import them from one place; the CLI
// imports them straight from ./validate.ts to avoid bundling this module's kysely dependency.
export { ConfigValidationError, MAX_VALUE_BYTES, looksLikeSecret, validateConfigKey } from "./validate.ts";

/** A per-app snapshot: the full key→value map + its ETag `version` (0 when the app has no config). */
export interface ConfigSnapshot {
  map: Record<string, string>;
  version: number;
}

/** One config entry as listed (never secret; plaintext is fine). */
export interface ConfigEntry {
  key: string;
  value: string;
  version: number;
  updatedBy: string;
  updatedAt: string; // ISO
}

export class AppConfigStore {
  constructor(private db: Db) {}

  /** The current per-app ETag: MAX(version) over the app's rows, or 0 when the app has no config. */
  private async currentVersion(app: string): Promise<number> {
    const r = await this.db
      .selectFrom("app_configs")
      .select((eb) => eb.fn.max<number>("version").as("v"))
      .where("app", "=", app)
      .executeTakeFirst();
    return Number((r?.v as number | null) ?? 0);
  }

  /** The full key→value map + its ETag. `map` is `{}` and `version` is 0 for an app with no config. */
  async get(app: string): Promise<ConfigSnapshot> {
    const rows = await this.db.selectFrom("app_configs").select(["key", "value", "version"]).where("app", "=", app).execute();
    const map: Record<string, string> = {};
    let version = 0;
    for (const r of rows) {
      map[r.key as string] = r.value as string;
      version = Math.max(version, Number(r.version));
    }
    return { map, version };
  }

  /** All entries (with metadata) for an app, sorted by key — for the CLI/console table. */
  async list(app: string): Promise<ConfigEntry[]> {
    const rows = await this.db.selectFrom("app_configs").selectAll().where("app", "=", app).orderBy("key").execute();
    return rows.map((r) => ({
      key: r.key as string,
      value: r.value as string,
      version: Number(r.version),
      updatedBy: r.updated_by as string,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    }));
  }

  /** Set (create-or-update) a key. Validates the key shape + value size cap + credential refusal, then
   *  upserts and bumps the per-app ETag. A no-op set (identical value) leaves the version unchanged so the
   *  SDK's poll doesn't see a spurious change. Throws `ConfigValidationError` on a rejected key/value. */
  async set(app: string, key: string, value: string, updatedBy: string): Promise<ConfigSnapshot> {
    const keyErr = validateConfigKey(key);
    if (keyErr) throw new ConfigValidationError(keyErr, "bad_key");
    if (typeof value !== "string") throw new ConfigValidationError("value must be a string", "bad_key");
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new ConfigValidationError(`value too large (max ${MAX_VALUE_BYTES} bytes)`, "too_large");
    const secretErr = looksLikeSecret(key, value);
    if (secretErr) throw new ConfigValidationError(secretErr, "looks_secret");

    const existing = await this.db.selectFrom("app_configs").select("value").where("app", "=", app).where("key", "=", key).executeTakeFirst();
    if (existing && (existing.value as string) === value) return this.get(app); // no-op: don't churn the ETag

    const next = (await this.currentVersion(app)) + 1;
    await this.db
      .insertInto("app_configs")
      .values({ app, key, value, version: next, updated_by: updatedBy.toLowerCase(), updated_at: sql`now()` })
      .onConflict((oc) => oc.columns(["app", "key"]).doUpdateSet({ value, version: next, updated_by: updatedBy.toLowerCase(), updated_at: sql`now()` }))
      .execute();
    return this.get(app);
  }

  /** Remove a key. Bumps the per-app ETag iff a row was actually deleted (so a no-op rm doesn't churn it).
   *  To keep the ETag monotonic when a non-highest row is removed, the highest surviving row is re-stamped
   *  with the new version. Returns the resulting snapshot. */
  async rm(app: string, key: string): Promise<ConfigSnapshot> {
    const next = (await this.currentVersion(app)) + 1;
    const res = await this.db.deleteFrom("app_configs").where("app", "=", app).where("key", "=", key).executeTakeFirst();
    if (Number(res.numDeletedRows ?? 0n) === 0) return this.get(app); // nothing removed → no ETag bump

    // Advance MAX(version) to `next` by re-stamping the highest surviving row(s). Without this, deleting a
    // NON-highest row would leave MAX unchanged → a false 304 on the next poll. When no rows survive, the
    // app version resets to 0 (empty), which is safe (any prior ETag differs).
    const maxSurviving = await this.currentVersion(app);
    if (maxSurviving > 0) {
      await this.db.updateTable("app_configs").set({ version: next }).where("app", "=", app).where("version", "=", maxSurviving).execute();
    }
    return this.get(app);
  }
}
