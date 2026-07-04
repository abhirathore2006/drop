// The SQL console executor (I4) — a read-only query port + its real pg implementation.
//
// The API route (`POST /v1/databases/:name/query`) depends on the SqlQueryExecutor PORT, never on a
// concrete pg connection — so the route is fully testable with a scripted fake (no real Postgres; the
// repo's test infra uses PGlite, not a real server) and the real connector is exercised only in-cluster
// (integration-tested manually). This mirrors how the API depends on KubeClient/BlobStore, not concretes.
//
// SECURITY MODEL (enforced HERE, in the real executor — the route only gates WHO):
//   - read-only is SESSION-ENFORCED, NOT parsed: the session runs `SET default_transaction_read_only = on`
//     and EVERY statement runs inside a `BEGIN READ ONLY` transaction. There is deliberately NO SQL-grammar
//     allowlist — a write (INSERT/UPDATE/DDL/…) inside a READ ONLY tx simply errors at the engine
//     ("cannot execute … in a read-only transaction"), which no amount of clever SQL can talk its way out
//     of. A parser would be both leakier (comment/CTE/`;` tricks) and more brittle.
//   - `statement_timeout` bounds a runaway query (default 5s).
//   - a row cap (default 500) and a serialized-byte cap (default ~1MB) bound the response so a `select *`
//     over a huge table can't OOM the API or the browser — the caller gets 500 rows + `truncated: true`.
//   - it connects as the CNPG `app` role (NOT a superuser) read from the `<db>-app` Secret — least
//     privilege, the same credential an app uses.
import pg from "pg";

/** One column of a result set (name only — the console renders headers, types are not surfaced v1). */
export interface SqlColumn {
  name: string;
}

/** A read-only query request handed to the executor. `database` is the CNPG Cluster name; the executor
 *  derives host `<database>-rw.<namespace>.svc`, database `app`, user `app`. */
export interface SqlQueryRequest {
  namespace: string;
  database: string;
  sql: string;
  rowCap: number; // return at most this many rows (excess → truncated:true)
  byteCap: number; // return at most ~this many serialized bytes (excess → truncated:true)
  statementTimeoutMs: number; // per-statement engine timeout
}

/** A read-only query result. `rows` are arrays (positional, aligned to `columns`) — compact + duplicate-
 *  column-name safe. `truncated` is true when the row OR byte cap clipped the result. */
export interface SqlQueryResult {
  columns: SqlColumn[];
  rows: unknown[][];
  rowCount: number; // number of rows RETURNED (after capping)
  truncated: boolean;
  elapsedMs: number;
}

/** The executor port: run a read-only SQL statement, or REJECT with an Error whose `.message` is a
 *  sanitized engine message (no stack) — the route maps a rejection to a 400. */
export type SqlQueryExecutor = (req: SqlQueryRequest) => Promise<SqlQueryResult>;

/** A SQL/engine failure the route surfaces as a 400 with `.message` (never a stack). The real executor
 *  wraps pg errors in this; a connection failure is surfaced the same way (an honest, sanitized message). */
export class SqlQueryError extends Error {
  readonly name = "SqlQueryError";
}

interface PoolEntry {
  pool: pg.Pool;
  evict: ReturnType<typeof setTimeout>;
}

export interface SqlExecutorOptions {
  /** Read the `<db>-app` Secret's `{username, password}` (server-side only; the same secret-read
   *  mechanism the app-binding + password rotation use). Returns null when the Secret isn't present yet. */
  readAppCreds: (namespace: string, database: string) => Promise<{ username: string; password: string } | null>;
  /** Idle window (ms) after which a per-(ns,db) pool is fully ended + evicted from the map. Default 60s. */
  idleMs?: number;
}

/** Build the REAL read-only SQL executor.
 *
 *  CONNECTION LIFECYCLE (the chosen design, deliberately simple + leak-free): a tiny `Map` of short-lived
 *  pg Pools keyed by `${namespace}/${database}`. We do NOT hold a connection per request (that would leak
 *  a socket per in-flight query); instead each pool caps at a handful of clients that pg idle-closes on
 *  its own, and after `idleMs` of no queries the WHOLE pool is `end()`ed and dropped from the map — so a
 *  database queried once and never again leaves nothing behind. Each pool pins the read-only session on
 *  every fresh connection, so a pooled reuse can never inherit a writable session. This is preferred over
 *  connect-per-query (a fresh TCP + TLS + auth round-trip per keystroke-driven console query) while still
 *  never outliving its use. Only ever invoked in-cluster (the route 501s out-of-cluster before calling). */
export function makeSqlQueryExecutor(opts: SqlExecutorOptions): SqlQueryExecutor {
  const idleMs = opts.idleMs ?? 60_000;
  const pools = new Map<string, PoolEntry>();

  const evictLater = (key: string) => {
    const e = pools.get(key);
    if (!e) return;
    clearTimeout(e.evict);
    e.evict = setTimeout(() => {
      pools.delete(key);
      void e.pool.end().catch(() => {}); // best-effort; the map no longer references it
    }, idleMs);
    e.evict.unref?.(); // never keep the process alive just to evict an idle pool
  };

  async function poolFor(req: SqlQueryRequest): Promise<pg.Pool> {
    const key = `${req.namespace}/${req.database}`;
    const existing = pools.get(key);
    if (existing) {
      evictLater(key);
      return existing.pool;
    }
    const creds = await opts.readAppCreds(req.namespace, req.database);
    if (!creds) throw new SqlQueryError(`database "${req.database}" is not ready (its credentials Secret is absent) — try again once it is provisioned`);
    const pool = new pg.Pool({
      host: `${req.database}-rw.${req.namespace}.svc`,
      port: 5432,
      user: creds.username, // the CNPG `app` role — NOT a superuser
      password: creds.password,
      database: "app",
      max: 3,
      idleTimeoutMillis: 10_000, // pg closes an idle client on its own; the pool-level evict is the outer bound
      connectionTimeoutMillis: req.statementTimeoutMs, // don't hang forever dialing a down DB
      statement_timeout: req.statementTimeoutMs, // per-statement engine timeout, set on every connection
      // CNPG serves TLS; from an in-cluster server-side connector we negotiate it but don't verify the DB
      // CA (it isn't mounted here) — the network hop is the trusted pod network. Documented as in-cluster.
      ssl: { rejectUnauthorized: false },
      // Pin the read-only session the moment a connection is established, so a pooled reuse is ALWAYS
      // read-only even before the per-query BEGIN READ ONLY (belt-and-suspenders with the tx).
      options: "-c default_transaction_read_only=on",
    });
    // A pool-level error (e.g. a backend killed by statement_timeout) must never crash the API.
    pool.on("error", () => {});
    const entry: PoolEntry = { pool, evict: setTimeout(() => {}, 0) };
    pools.set(key, entry);
    evictLater(key);
    return pool;
  }

  return async (req: SqlQueryRequest): Promise<SqlQueryResult> => {
    const started = Date.now();
    let client: pg.PoolClient;
    try {
      const pool = await poolFor(req);
      client = await pool.connect();
    } catch (e) {
      // A connect/creds failure is surfaced with the SAME sanitized shape as a SQL error (→ 400).
      throw e instanceof SqlQueryError ? e : new SqlQueryError((e as Error).message);
    }
    try {
      // READ ONLY transaction: a write of any kind errors at the engine — this is the enforcement, not a
      // parser. `SET LOCAL default_transaction_read_only` is redundant with BEGIN READ ONLY but stated for
      // defence-in-depth; `statement_timeout` is already pinned at the connection level.
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL default_transaction_read_only = on");
      // rowMode:"array" → positional rows (compact + duplicate-column-name safe); fields give the names.
      const res = await client.query({ text: req.sql, rowMode: "array" });
      const fields = res.fields ?? [];
      const columns: SqlColumn[] = fields.map((f) => ({ name: f.name }));
      const all = (res.rows as unknown[][]) ?? [];
      // Row cap first, then byte cap: keep whole rows until either the row count or the serialized-byte
      // budget is hit, then stop and flag `truncated`. (v1 fetches the full result then caps in memory;
      // statement_timeout + this cap bound the blast radius. A streaming cursor is a future refinement —
      // it needs a cursor dependency we deliberately don't add here.)
      let truncated = all.length > req.rowCap;
      const rows: unknown[][] = [];
      let bytes = 0;
      for (const row of all.slice(0, req.rowCap)) {
        const rb = Buffer.byteLength(JSON.stringify(row ?? null));
        if (rows.length > 0 && bytes + rb > req.byteCap) {
          truncated = true;
          break;
        }
        bytes += rb;
        rows.push(row);
      }
      await client.query("ROLLBACK"); // read-only — nothing to commit; end the tx cleanly
      return { columns, rows, rowCount: rows.length, truncated, elapsedMs: Date.now() - started };
    } catch (e) {
      // Roll back the (aborted) tx so the pooled connection is reusable; ignore rollback failures.
      await client.query("ROLLBACK").catch(() => {});
      // Sanitize: surface ONLY the pg error message (e.g. `relation "x" does not exist`), never a stack.
      throw new SqlQueryError((e as Error).message);
    } finally {
      client.release();
    }
  };
}
