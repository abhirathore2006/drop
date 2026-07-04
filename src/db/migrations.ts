import { type Kysely, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { createHash } from "node:crypto";
import { tenantNamespace } from "../api/tenant.ts";

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

// App secrets: a registry of secret KEY NAMES + metadata (never values — values live in the
// SecretStore backend). Plus per-app runtime_state for the stop/start lifecycle.
const m0003_app_secrets: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("app_secret_keys")
      .addColumn("app", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("key", "text", (c) => c.notNull())
      .addColumn("fingerprint", "text", (c) => c.notNull())
      .addColumn("updated_by", "text", (c) => c.notNull())
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("app_secret_keys_pk", ["app", "key"])
      .execute();
    await db.schema.alterTable("sites").addColumn("runtime_state", "text", (c) => c.notNull().defaultTo("running")).execute();
  },
  async down() {
    /* forward-only */
  },
};

// Organisations: a logical group that OWNS resources, with org-level roles. Each user gets a
// PERSONAL org whose `namespace` is the LITERAL existing per-owner namespace (stored, not
// re-derived — the namespace hash is keyed on the full email and isn't recoverable from a slug),
// so backfill moves NO running workload. Teams are new orgs with their own namespace. Per-resource
// site_members survive as an ADDITIVE grant layer (no over-grant on migration).
const m0004_organisations: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("organisations")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("slug", "text", (c) => c.notNull().unique())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull()) // 'personal' | 'team'
      .addColumn("namespace", "text", (c) => c.notNull()) // the LITERAL k8s tenant namespace (data, not derived)
      .addColumn("created_by", "text", (c) => c.notNull().references("users.email"))
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
    // one personal org per user (the idempotent first-login bridge can't race two into existence)
    await sql`create unique index one_personal_org_per_user on organisations(created_by) where kind = 'personal'`.execute(db);

    await db.schema
      .createTable("org_members")
      .addColumn("org_id", "text", (c) => c.notNull().references("organisations.id").onDelete("cascade"))
      .addColumn("email", "text", (c) => c.notNull().references("users.email"))
      .addColumn("role", "text", (c) => c.notNull()) // owner | admin | member | viewer
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("org_members_pk", ["org_id", "email"])
      .execute();
    await sql`create unique index one_owner_per_org on org_members(org_id) where role = 'owner'`.execute(db);
    await db.schema.createIndex("org_members_email_idx").on("org_members").column("email").execute();

    // sites.org_id — nullable through the migration window; claimSite sets it going forward, and
    // can()/namespace resolution fall back to site_members + tenantNamespace(owner) when it's null.
    // ON DELETE RESTRICT (default) — deleting an org with live resources is blocked at the app layer.
    await db.schema.alterTable("sites").addColumn("org_id", "text", (c) => c.references("organisations.id")).execute();

    // Backfill: a personal org per existing site OWNER; namespace = the literal current namespace.
    const owners = await db.selectFrom("site_members").select("email").where("role", "=", "owner").distinct().execute();
    for (const { email } of owners as { email: string }[]) {
      const ns = tenantNamespace(email); // the EXACT existing namespace
      const slug = ns.replace(/^drop-t-/, ""); // unique (carries the email hash)
      const id = "org_" + createHash("sha256").update("personal:" + email).digest("hex").slice(0, 20);
      await db
        .insertInto("organisations")
        .values({ id, slug, name: email, kind: "personal", namespace: ns, created_by: email })
        .onConflict((oc: any) => oc.column("slug").doNothing())
        .execute();
      await db
        .insertInto("org_members")
        .values({ org_id: id, email, role: "owner" })
        .onConflict((oc: any) => oc.columns(["org_id", "email"]).doNothing())
        .execute();
      await db
        .updateTable("sites")
        .set({ org_id: id })
        .where("org_id", "is", null)
        .where("name", "in", (eb: any) => eb.selectFrom("site_members").select("site_name").where("email", "=", email).where("role", "=", "owner"))
        .execute();
    }
  },
  async down() {
    /* forward-only */
  },
};

// Append-only audit trail for mutating/admin actions (delete/transfer/suspend/role/visibility/
// db-password/share). bigserial id is monotonic → it's also the keyset-pagination cursor.
const m0005_audit_log: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("audit_log")
      .addColumn("id", "bigserial", (c) => c.primaryKey())
      .addColumn("at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("actor", "text", (c) => c.notNull())
      .addColumn("action", "text", (c) => c.notNull())
      .addColumn("target", "text")
      .addColumn("target_type", "text")
      .addColumn("org_id", "text")
      .addColumn("detail", "jsonb")
      .execute();
    // Common admin-console filters: by actor, by target. id DESC is the default browse order (PK index covers it).
    await db.schema.createIndex("audit_log_actor_idx").on("audit_log").column("actor").execute();
    await db.schema.createIndex("audit_log_target_idx").on("audit_log").column("target").execute();
  },
  async down() {
    /* forward-only */
  },
};

// Lease-based advisory locks (src/metastore/lock.ts): one row per key, stolen when its lease expires.
// Serializes deploy/release-Job runs per app (`deploy:<app>`) and, later, stack `up` (`stack:<id>`).
const m0006_locks: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("locks")
      .addColumn("key", "text", (c) => c.primaryKey())
      .addColumn("holder", "text", (c) => c.notNull())
      .addColumn("expires_at", "timestamptz", (c) => c.notNull())
      .execute();
  },
  async down() {
    /* forward-only */
  },
};

// Stacks (B2): a declarative multi-resource group + its desired-state spec. Resources stay ordinary
// `sites` rows (every existing route/role/console page keeps working) — a stack is grouping + desired
// state, its edges live in the `spec` jsonb. `stack_resources` maps a resource KEY to the site name it
// materialized as (`<stack>-<key>` unless the resource carried an explicit name). Name unique per org.
const m0007_stacks: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("stacks")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("org_id", "text", (c) => c.notNull().references("organisations.id").onDelete("cascade"))
      .addColumn("spec", "jsonb", (c) => c.notNull())
      .addColumn("spec_version", "integer", (c) => c.notNull().defaultTo(1))
      .addColumn("from_template", "text") // D2 provenance (template slug)
      .addColumn("from_template_version", "text") // D2 provenance (template version)
      .addColumn("created_by", "text", (c) => c.notNull().references("users.email"))
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
    // A stack name is unique within its org (the reconcile target is (org, name)); org_id leads the
    // index so it also serves the org-scoped list.
    await db.schema.createIndex("one_stack_name_per_org").on("stacks").columns(["org_id", "name"]).unique().execute();

    await db.schema
      .createTable("stack_resources")
      .addColumn("stack_id", "text", (c) => c.notNull().references("stacks.id").onDelete("cascade"))
      .addColumn("resource_key", "text", (c) => c.notNull())
      .addColumn("site_name", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("stack_resources_pk", ["stack_id", "resource_key"])
      .execute();
    // A site belongs to at most one stack resource (no two stacks materialize the same name).
    await db.schema.createIndex("stack_resources_site_uniq").on("stack_resources").column("site_name").unique().execute();
  },
  async down() {
    /* forward-only */
  },
};

// Per-org quota overrides (Future.md item 10, API level). One row per (org, key); value is text
// (a k8s quantity or an integer string) parsed at the enforcement point. Absent → platform default.
// Keys v1: max_workloads, max_db_storage (per-database cap), storage_budget_bytes (org-wide budget).
const m0008_org_quotas: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("org_quotas")
      .addColumn("org_id", "text", (c) => c.notNull().references("organisations.id").onDelete("cascade"))
      .addColumn("key", "text", (c) => c.notNull())
      .addColumn("value", "text", (c) => c.notNull())
      .addColumn("updated_by", "text", (c) => c.notNull())
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("org_quotas_pk", ["org_id", "key"])
      .execute();
  },
  async down() {
    /* forward-only */
  },
};

// TCP exposure registry (A2b): one row per exposed workload. `mode='sni'` routes by the TLS SNI
// hostname on a shared port (no port consumed → `port` NULL); `mode='port'` allocates a dedicated
// port from the dynamic pool (`port` set + UNIQUE — a partial unique index so many NULL sni rows
// coexist). Cascades on the owning site's delete. The edge-tcp router reads it read-only; the API's
// expose routes are the sole writer.
const m0009_tcp_endpoints: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("tcp_endpoints")
      .addColumn("site_name", "text", (c) => c.primaryKey().references("sites.name").onDelete("cascade"))
      .addColumn("port", "integer")
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("protocol", "text", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
    // A dynamic port maps to at most one workload. Partial index → NULL (sni-mode) rows don't collide.
    await sql`create unique index one_workload_per_tcp_port on tcp_endpoints(port) where port is not null`.execute(db);
  },
  async down() {
    /* forward-only */
  },
};

/** All Drop migrations, in order. New schema changes append here. */
export class InlineMigrations implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "0001_init": m0001_init,
      "0002_workload_type": m0002_workload_type,
      "0003_app_secrets": m0003_app_secrets,
      "0004_organisations": m0004_organisations,
      "0005_audit_log": m0005_audit_log,
      "0006_locks": m0006_locks,
      "0007_stacks": m0007_stacks,
      "0008_org_quotas": m0008_org_quotas,
      "0009_tcp_endpoints": m0009_tcp_endpoints,
    };
  }
}
