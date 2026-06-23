// Server-only Postgres access for the link board. This module is imported only from server
// functions (createServerFn handlers), so `pg` and the connection pool never reach the client
// bundle. It connects with the standard libpq PG* env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/
// PGDATABASE) that you map from `drop db create` + `drop db password` (see ../DATABASE_APPS.md).
// CNPG serves a self-signed (operator-CA) TLS cert, so we encrypt in transit WITHOUT verifying it
// — the app and DB share one tenant namespace and are isolated by NetworkPolicy. Set
// PGSSLMODE=disable to turn TLS off entirely.
import { Pool } from 'pg'

export type Item = {
  id: number
  title: string
  url: string | null
  created_at: string
}

// One pool per server process. Reused across server-function invocations.
const pool = new Pool({
  host: process.env.PGHOST, // the managed DB's `-rw` Service, e.g. board-db-rw
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'app',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'app',
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 5,
})

// Create the table (and confirm connectivity) with a retry loop — on first deploy the database
// may still be starting, and after a scale-from-zero the pod reconnects here. We memoize the
// in-flight promise so concurrent loaders/mutations share a single init instead of racing.
let ready: Promise<void> | null = null

export function ensureReady(): Promise<void> {
  if (ready) return ready
  ready = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS items (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          url TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`)
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM items')
        console.log(`board: connected to Postgres (${rows[0].n} existing items)`)
        return
      } catch (e) {
        if (attempt > 30) {
          ready = null // let a later request retry instead of caching the failure forever
          throw e
        }
        console.log(`board: DB not ready (attempt ${attempt}): ${(e as Error).message}`)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  })()
  return ready
}

export async function listItems(): Promise<Item[]> {
  await ensureReady()
  const { rows } = await pool.query<Item>(
    'SELECT id, title, url, created_at FROM items ORDER BY id DESC',
  )
  return rows
}

export async function getItem(id: number): Promise<Item | null> {
  await ensureReady()
  const { rows } = await pool.query<Item>(
    'SELECT id, title, url, created_at FROM items WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

export async function createItem(title: string, url: string | null): Promise<Item> {
  await ensureReady()
  const { rows } = await pool.query<Item>(
    'INSERT INTO items (title, url) VALUES ($1, $2) RETURNING id, title, url, created_at',
    [title, url],
  )
  return rows[0]
}

export async function updateItem(id: number, title: string, url: string | null): Promise<void> {
  await ensureReady()
  await pool.query('UPDATE items SET title = $1, url = $2 WHERE id = $3', [title, url, id])
}

export async function deleteItem(id: number): Promise<void> {
  await ensureReady()
  await pool.query('DELETE FROM items WHERE id = $1', [id])
}
