import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import type { Db } from "./db.ts";
import { InlineMigrations } from "./migrations.ts";

const LOCK_KEY = 4_829_173; // stable advisory-lock id for Drop migrations

/**
 * Migrate to latest under a Postgres advisory lock so concurrent API replicas
 * (HPA rollouts) serialize: the first migrates, the rest block then proceed.
 * (Kysely's Migrator also locks its own table; this is belt-and-suspenders.)
 */
export async function runMigrations(db: Db): Promise<void> {
  await sql`select pg_advisory_lock(${LOCK_KEY})`.execute(db);
  try {
    const migrator = new Migrator({ db, provider: new InlineMigrations() });
    const { error, results } = await migrator.migrateToLatest();
    for (const r of results ?? []) {
      if (r.status === "Error") throw new Error(`migration failed: ${r.migrationName}`);
    }
    if (error) throw error instanceof Error ? error : new Error(String(error));
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.execute(db);
  }
}
