import {
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryCompiler,
  type QueryResult,
  type CompiledQuery,
} from "kysely";
import type { PGlite } from "@electric-sql/pglite";

/**
 * Minimal Kysely dialect over an in-process PGlite instance — test-only.
 * PGlite is a single in-memory connection, so all access is serialized;
 * transactions are plain begin/commit/rollback on that one connection.
 */
class PGliteConnection implements DatabaseConnection {
  constructor(private pg: PGlite) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const res = await this.pg.query(compiled.sql, [...compiled.parameters]);
    return {
      rows: res.rows as R[],
      numAffectedRows: BigInt(res.affectedRows ?? 0),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("PGlite dialect does not support streaming");
  }
}

class PGliteDriver implements Driver {
  private conn: PGliteConnection;
  constructor(private pg: PGlite) {
    this.conn = new PGliteConnection(pg);
  }
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.conn;
  }
  async beginTransaction(conn: DatabaseConnection): Promise<void> {
    await this.pg.query("begin");
    void conn;
  }
  async commitTransaction(): Promise<void> {
    await this.pg.query("commit");
  }
  async rollbackTransaction(): Promise<void> {
    await this.pg.query("rollback");
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {
    await this.pg.close();
  }
}

/** PostgresAdapter, but migration locks are no-ops (single test connection). */
class PGliteAdapter extends PostgresAdapter {
  override async acquireMigrationLock(): Promise<void> {}
  override async releaseMigrationLock(): Promise<void> {}
}

export class PGliteDialect implements Dialect {
  constructor(private pg: PGlite) {}
  createAdapter() {
    return new PGliteAdapter();
  }
  createDriver(): Driver {
    return new PGliteDriver(this.pg);
  }
  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>) {
    return new PostgresIntrospector(db);
  }
}
