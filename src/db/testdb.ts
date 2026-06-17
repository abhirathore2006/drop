import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { PGlite } from "@electric-sql/pglite";
import type { Database } from "./schema.ts";
import type { Db } from "./db.ts";
import { PGliteDialect } from "./pglite-dialect.ts";
import { InlineMigrations } from "./migrations.ts";

/** Fresh in-process Postgres (PGlite) with all migrations applied. Test-only. */
export async function makeTestDb(): Promise<Db> {
  const pg = await PGlite.create(); // in-memory
  const db = new Kysely<Database>({ dialect: new PGliteDialect(pg) });
  const migrator = new Migrator({ db, provider: new InlineMigrations() });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === "Error") throw new Error(`migration failed: ${r.migrationName}`);
  }
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return db;
}
