import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

export type Db = Kysely<Database>;

/** Build a Kysely instance + its pool from a connection string. */
export function makeDb(url: string): { db: Db; pool: pg.Pool } {
  // bigint (oid 20) → JS number; our byte counts stay within safe-int range.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)) as unknown as number);
  const pool = new pg.Pool({ connectionString: url });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
