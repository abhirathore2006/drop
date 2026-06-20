import { type Kysely, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

const m0001_init: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("users")
      .addColumn("email", "text", (c) => c.primaryKey())
      .addColumn("name", "text")
      .addColumn("role", "text", (c) => c.notNull().defaultTo("member"))
      .addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("last_login_at", "timestamptz")
      .execute();

    await db.schema
      .createTable("sites")
      .addColumn("name", "text", (c) => c.primaryKey())
      .addColumn("current_version", "text")
      .addColumn("visibility", "text", (c) => c.notNull().defaultTo("public"))
      .addColumn("password_hash", "text")
      .addColumn("config", "jsonb")
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema
      .createTable("site_members")
      .addColumn("site_name", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("email", "text", (c) => c.notNull().references("users.email"))
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("site_members_pk", ["site_name", "email"])
      .execute();
    // exactly one owner per site
    await sql`create unique index one_owner_per_site on site_members(site_name) where role = 'owner'`.execute(db);
    await db.schema.createIndex("site_members_email_idx").on("site_members").column("email").execute();

    await db.schema
      .createTable("versions")
      .addColumn("site_name", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("published_by", "text", (c) => c.notNull())
      .addColumn("created_at", "timestamptz", (c) => c.notNull())
      .addColumn("file_count", "integer", (c) => c.notNull())
      .addColumn("bytes", "bigint", (c) => c.notNull())
      .addColumn("config", "jsonb")
      .addPrimaryKeyConstraint("versions_pk", ["site_name", "id"])
      .execute();

    await db.schema
      .createTable("auth_handles")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("poll_token", "text", (c) => c.notNull())
      .addColumn("code_verifier", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("token", "text")
      .addColumn("error", "text")
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
  },
  async down() {
    /* forward-only */
  },
};

// Workload type discriminator: a row in `sites` is a static site by default, or
// an "app" (container workload). Existing rows backfill to 'site'. Apps share the
// one name namespace with sites (same PK), so a name can't be both.
const m0002_workload_type: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable("sites").addColumn("type", "text", (c) => c.notNull().defaultTo("site")).execute();
  },
  async down() {
    /* forward-only */
  },
};

/** All Drop migrations, in order. New schema changes append here. */
export class InlineMigrations implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { "0001_init": m0001_init, "0002_workload_type": m0002_workload_type };
  }
}
