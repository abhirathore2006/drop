// One shared pg Pool, built from the standard libpq PG* env vars you map from `drop db create`
// + `drop db password` (see examples/DATABASE_APPS.md). Cached on globalThis so we keep ONE pool
// across requests (and across hot-reloads in dev). CNPG serves a self-signed (operator-CA) TLS
// cert, so we encrypt in transit without verifying it; set PGSSLMODE=disable to turn TLS off.
import pg from "pg";

const { Pool } = pg;

const g = globalThis;
export const pool =
  g.__notesPool ||
  (g.__notesPool = new Pool({
    host: process.env.PGHOST, // the managed DB's `-rw` Service, e.g. notes-db-rw
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "app",
    password: process.env.PGPASSWORD || "",
    database: process.env.PGDATABASE || "app",
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    max: 5,
  }));

// Create the table once per process. The promise is memoised so concurrent requests share it,
// and it retries because the DB may still be coming up on first deploy / scale-from-zero.
let ready;
export function ensureSchema() {
  ready ||= (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS notes (
          id SERIAL PRIMARY KEY,
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        return;
      } catch (e) {
        if (attempt > 30) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
  return ready;
}
