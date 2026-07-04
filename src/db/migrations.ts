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

// Service accounts / scoped CI tokens (J1): an org-owned bearer credential for automation. Only the
// sha256 token_hash is stored (unique — the per-request lookup key); the secret is shown once at create.
// `scopes` is a jsonb array of `verb[:resource|:*]` strings. Revocation is a SOFT mark (revoked_at) so
// the row keeps its audit value; org delete cascades. last_used_at is bumped throttled (~1/min) on use.
const m0010_service_tokens: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("service_tokens")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("org_id", "text", (c) => c.notNull().references("organisations.id").onDelete("cascade"))
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("scopes", "jsonb", (c) => c.notNull())
      .addColumn("token_hash", "text", (c) => c.notNull())
      .addColumn("expires_at", "timestamptz") // null = never expires
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("last_used_at", "timestamptz")
      .addColumn("revoked_at", "timestamptz") // soft revocation — the row stays for audit
      .execute();
    // The hash is the per-request lookup key → unique + indexed.
    await db.schema.createIndex("service_tokens_hash_uniq").on("service_tokens").column("token_hash").unique().execute();
    // Org-scoped listing (Settings › Tokens, `drop token ls`).
    await db.schema.createIndex("service_tokens_org_idx").on("service_tokens").column("org_id").execute();
  },
  async down() {
    /* forward-only */
  },
};

// Template registry (D1): a per-INSTANCE catalog of publishable stack specs. A `templates` row is the
// named, org-owned, visibility-scoped catalog entry (slug UNIQUE instance-wide — the golden-path
// namespace); `template_versions` holds each immutable published version's sanitized stack spec, its
// variable declarations, and a readme. `visibility='public'` is instance-wide (the internal-tool
// default); `visibility='org'` is members-only. Instantiating (`drop new <slug>`) resolves the latest
// (or a pinned) version, substitutes variables, and runs the SAME reconcile as a stack `up`, recording
// provenance on the created stack (`from_template`/`from_template_version` — columns already on `stacks`).
const m0011_templates: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("templates")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("slug", "text", (c) => c.notNull().unique()) // instance-wide golden-path namespace
      .addColumn("org_id", "text", (c) => c.notNull().references("organisations.id").onDelete("cascade"))
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("description", "text")
      .addColumn("visibility", "text", (c) => c.notNull().defaultTo("org")) // 'public' (instance-wide) | 'org' (members only)
      .addColumn("created_by", "text", (c) => c.notNull().references("users.email"))
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
    // Visibility-scoped browse: public templates are instance-wide; org templates filter by org_id.
    await db.schema.createIndex("templates_visibility_idx").on("templates").columns(["visibility", "org_id"]).execute();

    await db.schema
      .createTable("template_versions")
      .addColumn("template_id", "text", (c) => c.notNull().references("templates.id").onDelete("cascade"))
      .addColumn("version", "text", (c) => c.notNull()) // monotonic integer-as-text ("1","2",…)
      .addColumn("spec", "jsonb", (c) => c.notNull()) // the sanitized, stripped, template-relative stack spec
      .addColumn("variables", "jsonb", (c) => c.notNull()) // TemplateVariable[] declarations
      .addColumn("readme", "text")
      .addColumn("created_by", "text", (c) => c.notNull().references("users.email"))
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("template_versions_pk", ["template_id", "version"])
      .execute();
  },
  async down() {
    /* forward-only */
  },
};

// Preview registry (E1): a labeled, expiring pointer to a SPECIFIC version, served at
// `<site>--<label>.<baseDomain>` alongside (never instead of) the parent's `current_version`. PK
// (site_name, label) — republishing the same label re-points it at a new version (the API upserts
// via POST .../versions?preview=<label>). `version_id` deliberately carries NO foreign key to
// `versions`: the existing publish-time pruneVersions/GC may reap an old version's bytes+row before
// its preview's OWN expires_at passes — accepted, documented behavior (see docs/previews.html)
// rather than new cross-feature protection. Cascades on the owning site's delete. The edge resolves
// (site_name,label) read-only; the API's preview routes are the sole writer; the housekeeping sweep
// (bin/api.ts) is the sole deleter of EXPIRED rows.
const m0012_previews: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("previews")
      .addColumn("site_name", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("label", "text", (c) => c.notNull())
      .addColumn("version_id", "text", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("expires_at", "timestamptz", (c) => c.notNull())
      .addPrimaryKeyConstraint("previews_pk", ["site_name", "label"])
      .execute();
    // The sweep's hot path: find everything past its expiry, cluster-wide, without a table scan.
    await db.schema.createIndex("previews_expires_at_idx").on("previews").column("expires_at").execute();
  },
  async down() {
    /* forward-only */
  },
};

// Tunnel tickets (A3, `db:proxy`): a short-lived, single-use credential for the authenticated psql
// tunnel. `POST /v1/databases/:name/tunnel-ticket` (authz `connect`) mints one bound to the caller +
// the database; the WebSocket tunnel upgrade redeems it EXACTLY once. Only the sha256 token_hash is
// stored (unique — the redemption lookup key); the raw `drop_tt_…` secret is returned once and never
// persisted. `used_at` is the single-use latch (flipped by a conditional UPDATE so redemption is
// atomic); `expires_at` is a 60s TTL. Cascades on the owning database's delete — a dropped DB
// invalidates any outstanding ticket for it.
const m0013_tunnel_tickets: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("tunnel_tickets")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("token_hash", "text", (c) => c.notNull())
      .addColumn("site_name", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("email", "text", (c) => c.notNull())
      .addColumn("expires_at", "timestamptz", (c) => c.notNull())
      .addColumn("used_at", "timestamptz") // null = unredeemed; set once at redemption (single-use)
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
    // The hash is the per-redemption lookup key → unique + indexed.
    await db.schema.createIndex("tunnel_tickets_hash_uniq").on("tunnel_tickets").column("token_hash").unique().execute();
    // Expiry sweep can find spent/expired rows without a table scan (tickets are transient — 60s TTL).
    await db.schema.createIndex("tunnel_tickets_expires_at_idx").on("tunnel_tickets").column("expires_at").execute();
  },
  async down() {
    /* forward-only */
  },
};

// Edge traffic + uptime rollups (G2 / G2b). Two sibling minute-bucketed tables, both 30d-retained
// (swept in the API housekeeping loop). `traffic_minutes` is the edge's per-host request rollup: the
// edge (and edge-tcp) accumulate in-process and UPSERT one row per host per minute (additive merge —
// see MetricsStore.flushTraffic for the percentile-merge honesty note). It carries NO foreign key to
// `sites`: the collector key is the resolved HOST label, which can be a preview host (`site--label`)
// or any string the edge served — not necessarily a live `sites` row — so retention (not a cascade)
// is the sole cleanup. `uptime_checks` is the API poller's synthetic-probe rollup: its `site_name` is
// ALWAYS a real site (the poller enumerates live workloads), so it DOES cascade on the site's delete.
const m0014_edge_metrics: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("traffic_minutes")
      .addColumn("site_name", "text", (c) => c.notNull())
      .addColumn("minute", "timestamptz", (c) => c.notNull())
      .addColumn("requests", "bigint", (c) => c.notNull().defaultTo(0))
      .addColumn("bytes_in", "bigint", (c) => c.notNull().defaultTo(0))
      .addColumn("bytes_out", "bigint", (c) => c.notNull().defaultTo(0))
      .addColumn("p50_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("p95_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("s2xx", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("s4xx", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("s5xx", "integer", (c) => c.notNull().defaultTo(0))
      .addPrimaryKeyConstraint("traffic_minutes_pk", ["site_name", "minute"])
      .execute();
    // The retention sweep deletes everything older than a cutoff cluster-wide — a `minute` index
    // makes that a range scan, not a table scan (the PK leads with site_name, so it doesn't cover it).
    await db.schema.createIndex("traffic_minutes_minute_idx").on("traffic_minutes").column("minute").execute();

    await db.schema
      .createTable("uptime_checks")
      .addColumn("site_name", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("minute", "timestamptz", (c) => c.notNull())
      .addColumn("ok", "boolean", (c) => c.notNull())
      .addColumn("latency_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("status", "integer", (c) => c.notNull().defaultTo(0)) // HTTP status, or 0 for a TCP-connect probe
      .addPrimaryKeyConstraint("uptime_checks_pk", ["site_name", "minute"])
      .execute();
    await db.schema.createIndex("uptime_checks_minute_idx").on("uptime_checks").column("minute").execute();
  },
  async down() {
    /* forward-only */
  },
};

// (J3) `drop exec` reuses the single-use ticket machinery. Two additive columns generalize
// `tunnel_tickets` from db:proxy-only to a KINDED ticket: `kind` discriminates a `tunnel` ticket
// (the A3 psql splice) from an `exec` ticket (the J3 shell bridge), and `command` binds the exact
// argv an exec ticket authorizes — so a redeemed WS upgrade can't escalate to a DIFFERENT command
// than the one `can("exec")` was checked against at issuance. `kind` defaults to 'tunnel' so every
// pre-existing row (and the unchanged A3 issue path) keeps its meaning with no backfill. `command`
// is null for tunnel tickets (a psql tunnel has no argv).
const m0015_exec_tickets: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .alterTable("tunnel_tickets")
      .addColumn("kind", "text", (c) => c.notNull().defaultTo("tunnel")) // 'tunnel' (A3) | 'exec' (J3)
      .addColumn("command", "jsonb") // exec argv (string[]) bound at issuance; null for a tunnel ticket
      .execute();
  },
  async down() {
    /* forward-only */
  },
};

// (E2) App previews reuse the E1 `previews` table (a labeled, expiring pointer under a parent
// workload). Two additive columns generalize it from static-site-only to a KINDED preview:
//  - `kind` discriminates a `site` preview (E1: `version_id` is a real static version) from an
//    `app` preview (E2: `version_id` holds the deployed IMAGE ref, and a parallel `<name>-p-<label>`
//    manifest set runs alongside the parent). The sweep (bin/api.ts) reads `kind` to decide whether an
//    expired row also needs a kube teardown (`deleteApp`) vs. just dropping the row.
//  - `has_db` records whether an `app` preview owns a `--with-db` empty CNPG clone (`<name>-p-<label>-db`)
//    that must ALSO be torn down at expiry. This CANNOT be inferred from the parent (it's a per-preview
//    property), so it is persisted here.
// `kind` defaults to 'site' so every pre-existing E1 row keeps its meaning with no backfill; `has_db`
// defaults false (a site preview never has one).
const m0016_app_previews: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .alterTable("previews")
      .addColumn("kind", "text", (c) => c.notNull().defaultTo("site")) // 'site' (E1) | 'app' (E2)
      .addColumn("has_db", "boolean", (c) => c.notNull().defaultTo(sql`false`)) // (E2) app preview owns a --with-db clone
      .execute();
  },
  async down() {
    /* forward-only */
  },
};

// (G3) Alerting / notifications. Two tables:
//  - `events`: a per-org, keyset-paged incident feed (bigserial id → the cursor, exactly like
//    `audit_log`). `site_name` is nullable (org-level events like a quota warning carry no site) and is
//    NOT FK-bound — an incident may outlive the resource it names (a crash-loop event stays for the
//    post-mortem after the app is deleted), and org-delete cascades sweep it anyway. `severity` is
//    'info' | 'warning' | 'error'; `detail` is jsonb (a `count` accrues there on dedup). `resolved_at`
//    NULL = an OPEN incident; the DEDUP rule keeps at most one open row per (org, site_name, kind), so a
//    repeat emit while one is open bumps its count + created_at instead of inserting, and recovery sets
//    resolved_at. 30d retention, swept in the same housekeeping loop as the G2 rollups.
//  - `event_webhooks`: one outbound webhook per org (`org_id` PK) — a Slack/Teams incoming-webhook URL
//    (or any endpoint). `secret` (nullable) HMAC-signs the delivery (`X-Drop-Signature`) when set.
const m0017_events: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("events")
      .addColumn("id", "bigserial", (c) => c.primaryKey())
      .addColumn("org_id", "text", (c) => c.notNull().references("organisations.id").onDelete("cascade"))
      .addColumn("site_name", "text") // nullable — org-level events (quota) carry no site; not FK-bound
      .addColumn("kind", "text", (c) => c.notNull()) // crashloop | deploy_failed | stack_halted | quota | preview_expiring
      .addColumn("severity", "text", (c) => c.notNull()) // 'info' | 'warning' | 'error'
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("detail", "jsonb")
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("resolved_at", "timestamptz") // null = OPEN incident; set on recovery/resolve
      .execute();
    // Org-scoped keyset browse (newest-first is id DESC within the org) + the feed list's hot path.
    await db.schema.createIndex("events_org_id_idx").on("events").columns(["org_id", "id"]).execute();
    // Dedup + the unread badge: locate the OPEN incident per (org, kind, site) and count unresolved rows
    // — a partial index over just the open set (the rows either query touches).
    await sql`create index events_open_idx on events(org_id, kind, site_name) where resolved_at is null`.execute(db);

    await db.schema
      .createTable("event_webhooks")
      .addColumn("org_id", "text", (c) => c.primaryKey().references("organisations.id").onDelete("cascade"))
      .addColumn("url", "text", (c) => c.notNull())
      .addColumn("secret", "text") // null = unsigned delivery; set → HMAC-SHA256 X-Drop-Signature
      .addColumn("updated_by", "text", (c) => c.notNull())
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
  },
  async down() {
    /* forward-only */
  },
};

// (L4) Runtime config / feature flags — a per-app, NON-SECRET key/value store. A lighter path than a
// redeploy for flipping a flag or tweaking a knob. Values are size-capped and, by definition, non-secret
// (the store refuses credential-looking values via the D1 heuristic — secrets stay in the write-only
// secret path). `version` is the per-app monotonic ETag: every set/rm stamps the mutated (or a surviving)
// row with the next value, so the app-level version = MAX(version) over the app's rows advances on any
// mutation and `GET /v1/apps/:name/config` can answer `If-None-Match` with a cheap 304. PK (app, key);
// `app` FKs `sites.name` with ON DELETE CASCADE so an app's config is reaped with the app (like
// `app_secret_keys`), needing no delete-handler change.
const m0018_app_configs: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("app_configs")
      .addColumn("app", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("key", "text", (c) => c.notNull())
      .addColumn("value", "text", (c) => c.notNull())
      .addColumn("version", "integer", (c) => c.notNull().defaultTo(1)) // per-app monotonic ETag stamp
      .addColumn("updated_by", "text", (c) => c.notNull())
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("app_configs_pk", ["app", "key"])
      .execute();
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
      "0010_service_tokens": m0010_service_tokens,
      "0011_templates": m0011_templates,
      "0012_previews": m0012_previews,
      "0013_tunnel_tickets": m0013_tunnel_tickets,
      "0014_edge_metrics": m0014_edge_metrics,
      "0015_exec_tickets": m0015_exec_tickets,
      "0016_app_previews": m0016_app_previews,
      "0017_events": m0017_events,
      "0018_app_configs": m0018_app_configs,
    };
  }
}
