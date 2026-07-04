import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import type { SiteConfig } from "../site-config.ts";
import { MAX_DB_STORAGE } from "../db-config.ts";
import { tenantNamespace } from "../api/tenant.ts";
import {
  type Member,
  type Site,
  type SitePointer,
  type Visibility,
  type WorkloadType,
  type VersionMeta,
  type SecretKeyMeta,
  type RuntimeState,
  SiteNotFoundError,
} from "./types.ts";
import type { UptimeTarget } from "../metrics/uptime.ts";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const parseCfg = (v: unknown): SiteConfig | undefined =>
  v == null ? undefined : typeof v === "string" ? (JSON.parse(v) as SiteConfig) : (v as SiteConfig);
// versions.config is jsonb holding EITHER a SiteConfig (site publish) or an AppConfig (H1 app
// deploy/rollback) — same column, discriminated only by the workload's own `type`, so parsing it
// needs the wider type (unlike sites.config, which is always a SiteConfig).
const parseVersionCfg = (v: unknown): VersionMeta["config"] =>
  v == null ? undefined : typeof v === "string" ? (JSON.parse(v) as VersionMeta["config"]) : (v as VersionMeta["config"]);
const encCfg = (c?: unknown): string | null => (c ? JSON.stringify(c) : null);

/**
 * MetaStore is the single seam over all site metadata, now backed by Postgres.
 * File bytes still live in S3 under filesPrefix(); this only stores metadata.
 */
export class MetaStore {
  constructor(private db: Db) {}

  /** S3 byte-path bridge (unchanged contract). */
  filesPrefix(name: string, id: string) {
    return `sites/${name}/files/${id}/`;
  }

  private toSite(row: Record<string, unknown>, members: Member[]): Site {
    const owner = members.find((m) => m.role === "owner")?.email ?? "";
    return {
      name: row.name as string,
      type: (row.type as WorkloadType) ?? "site",
      owner,
      members,
      collaborators: members.filter((m) => m.role !== "owner").map((m) => m.email),
      currentVersion: (row.current_version as string | null) ?? null,
      visibility: row.visibility as Visibility,
      runtimeState: (row.runtime_state as "running" | "stopped") ?? "running",
      orgId: (row.org_id as string | null) ?? null,
      // org's stored namespace (joined as org_namespace); fallback to the owner-derived namespace
      // for any pre-orgs row whose org_id is still null (migration window).
      namespace: (row.org_namespace as string | undefined) ?? tenantNamespace(owner),
      config: parseCfg(row.config),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private async membersOf(name: string): Promise<Member[]> {
    const rows = await this.db
      .selectFrom("site_members")
      .select(["email", "role"])
      .where("site_name", "=", name)
      .execute();
    return rows.map((r) => ({ email: r.email, role: r.role }));
  }

  /** Atomic claim: insert workload (in the given org) + owner membership in one tx. Null if the name
   *  is taken (by a site OR an app — one shared name namespace). The caller authorizes the org first. */
  async claimSite(name: string, owner: string, type: WorkloadType, org: { id: string; namespace: string }): Promise<Site | null> {
    return await this.db.transaction().execute(async (tx) => {
      const site = await tx
        .insertInto("sites")
        .values({ name, type, org_id: org.id, updated_at: sql`now()` })
        .onConflict((oc) => oc.column("name").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!site) return null; // already claimed
      await tx.insertInto("site_members").values({ site_name: name, email: owner, role: "owner" }).execute();
      return this.toSite({ ...site, org_namespace: org.namespace }, [{ email: owner, role: "owner" }]);
    });
  }

  async getSitePlain(name: string): Promise<Site | null> {
    const row = await this.db
      .selectFrom("sites")
      .leftJoin("organisations", "organisations.id", "sites.org_id")
      .selectAll("sites")
      .select("organisations.namespace as org_namespace")
      .where("sites.name", "=", name)
      .executeTakeFirst();
    if (!row) return null;
    return this.toSite(row, await this.membersOf(name));
  }

  /** Lean edge read: pointer + visibility + password + config (no member list). */
  async getPointer(name: string): Promise<SitePointer | null> {
    const row = await this.db
      .selectFrom("sites")
      .select(["type", "current_version", "visibility", "password_hash", "config"])
      .where("name", "=", name)
      .executeTakeFirst();
    if (!row) return null;
    return {
      type: (row.type as WorkloadType) ?? "site",
      currentVersion: row.current_version ?? null,
      visibility: row.visibility as Visibility,
      passwordHash: row.password_hash ?? null,
      config: parseCfg(row.config),
    };
  }

  /** Read-modify-write under a row lock (replaces etag CAS). */
  async updateSite(name: string, mutate: (s: Site) => Site): Promise<Site> {
    return await this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom("sites").selectAll().where("name", "=", name).forUpdate().executeTakeFirst();
      if (!row) throw new SiteNotFoundError(name);
      const members = (
        await tx.selectFrom("site_members").select(["email", "role"]).where("site_name", "=", name).execute()
      ).map((r) => ({ email: r.email, role: r.role }));
      const next = mutate(this.toSite(row, members));
      const updated = await tx
        .updateTable("sites")
        .set({
          current_version: next.currentVersion,
          visibility: next.visibility,
          config: encCfg(next.config),
          updated_at: sql`now()`,
        })
        .where("name", "=", name)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toSite(updated, members);
    });
  }

  async setVisibility(name: string, visibility: Visibility, passwordHash: string | null): Promise<void> {
    const res = await this.db
      .updateTable("sites")
      .set({ visibility, password_hash: passwordHash, updated_at: sql`now()` })
      .where("name", "=", name)
      .executeTakeFirst();
    if (!res.numUpdatedRows) throw new SiteNotFoundError(name);
  }

  async addMember(name: string, email: string, role: "editor" | "viewer"): Promise<void> {
    await this.db
      .insertInto("site_members")
      .values({ site_name: name, email, role })
      .onConflict((oc) => oc.columns(["site_name", "email"]).doUpdateSet({ role }))
      .execute();
  }

  async removeMember(name: string, email: string): Promise<void> {
    await this.db
      .deleteFrom("site_members")
      .where("site_name", "=", name)
      .where("email", "=", email)
      .where("role", "!=", "owner") // owner cannot be removed, only transferred
      .execute();
  }

  /** Demote current owner → editor, promote newOwner → owner (atomic). */
  async transferOwner(name: string, newOwner: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const cur = await tx
        .selectFrom("site_members")
        .select(["email"])
        .where("site_name", "=", name)
        .where("role", "=", "owner")
        .forUpdate()
        .executeTakeFirst();
      if (cur && cur.email !== newOwner) {
        await tx
          .updateTable("site_members")
          .set({ role: "editor" })
          .where("site_name", "=", name)
          .where("email", "=", cur.email)
          .execute();
      }
      await tx
        .insertInto("site_members")
        .values({ site_name: name, email: newOwner, role: "owner" })
        .onConflict((oc) => oc.columns(["site_name", "email"]).doUpdateSet({ role: "owner" }))
        .execute();
    });
  }

  async deleteSite(name: string): Promise<void> {
    await this.db.deleteFrom("sites").where("name", "=", name).execute(); // cascades members + versions
  }

  /** Names of resources a user can see: per-resource grants (site_members) UNION every resource in
   *  an org they belong to (org-wide membership). */
  async listUserSites(email: string): Promise<string[]> {
    const e = email.toLowerCase();
    const rows = await this.db
      .selectFrom("sites")
      .select("name")
      .where((eb) =>
        eb.or([
          eb("name", "in", (q) => q.selectFrom("site_members").select("site_name").where("email", "=", e)),
          eb("org_id", "in", (q) => q.selectFrom("org_members").select("org_id").where("email", "=", e)),
        ]),
      )
      .orderBy("name")
      .execute();
    return rows.map((r) => r.name);
  }

  /** Keyset page over all sites (admin browse), optional name prefix / owner / type / org filters. */
  async listSitesPage(
    opts: { cursor?: string; limit?: number; prefix?: string; owner?: string; type?: WorkloadType; orgId?: string } = {},
  ): Promise<{ names: string[]; nextCursor?: string }> {
    const limit = opts.limit ?? 100;
    let q = this.db.selectFrom("sites").select("name").orderBy("name").limit(limit + 1);
    if (opts.cursor) q = q.where("name", ">", opts.cursor);
    if (opts.prefix) q = q.where("name", "like", opts.prefix.replace(/[%_\\]/g, "\\$&") + "%");
    if (opts.type) q = q.where("type", "=", opts.type);
    if (opts.orgId) q = q.where("org_id", "=", opts.orgId);
    // owner = the site's role='owner' membership row.
    if (opts.owner) {
      const owner = opts.owner;
      q = q.where("name", "in", (eb) =>
        eb.selectFrom("site_members").select("site_name").where("email", "=", owner).where("role", "=", "owner"),
      );
    }
    const rows = await q.execute();
    const names = rows.slice(0, limit).map((r) => r.name);
    const nextCursor = rows.length > limit ? names[names.length - 1] : undefined;
    return { names, nextCursor };
  }

  async putVersion(name: string, v: VersionMeta): Promise<void> {
    await this.db
      .insertInto("versions")
      .values({
        site_name: name,
        id: v.id,
        published_by: v.publishedBy,
        created_at: v.createdAt,
        file_count: v.fileCount,
        bytes: v.bytes,
        config: encCfg(v.config),
      })
      .onConflict((oc) => oc.columns(["site_name", "id"]).doNothing())
      .execute();
  }

  async deleteVersion(name: string, id: string): Promise<void> {
    await this.db.deleteFrom("versions").where("site_name", "=", name).where("id", "=", id).execute();
  }

  /** Version audit records, newest first (sortable id). */
  async listVersions(name: string): Promise<VersionMeta[]> {
    const rows = await this.db
      .selectFrom("versions")
      .selectAll()
      .where("site_name", "=", name)
      .orderBy("id", "desc")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      publishedBy: r.published_by,
      createdAt: iso(r.created_at),
      fileCount: r.file_count,
      bytes: Number(r.bytes),
      config: parseVersionCfg(r.config),
    }));
  }

  // ---- app secret KEY registry (names + metadata only — values live in the SecretStore) ----

  /** Record/refresh a secret key's metadata (never the value). */
  async upsertSecretKey(app: string, key: string, fingerprint: string, updatedBy: string): Promise<void> {
    await this.db
      .insertInto("app_secret_keys")
      .values({ app, key, fingerprint, updated_by: updatedBy, updated_at: sql`now()` })
      .onConflict((oc) => oc.columns(["app", "key"]).doUpdateSet({ fingerprint, updated_by: updatedBy, updated_at: sql`now()` }))
      .execute();
  }

  /** A site's secret keys + metadata, sorted by key. */
  async listSecretKeys(app: string): Promise<SecretKeyMeta[]> {
    const rows = await this.db.selectFrom("app_secret_keys").selectAll().where("app", "=", app).orderBy("key").execute();
    return rows.map((r) => ({ key: r.key, fingerprint: r.fingerprint, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) }));
  }

  async deleteSecretKey(app: string, key: string): Promise<void> {
    await this.db.deleteFrom("app_secret_keys").where("app", "=", app).where("key", "=", key).execute();
  }

  /** Drop the entire secret-key registry for an app (e.g. on ownership transfer). */
  async clearSecretKeys(app: string): Promise<void> {
    await this.db.deleteFrom("app_secret_keys").where("app", "=", app).execute();
  }

  /** Set an app's runtime state (stop/start lifecycle). */
  async setRuntimeState(name: string, state: RuntimeState): Promise<void> {
    await this.db.updateTable("sites").set({ runtime_state: state, updated_at: sql`now()` }).where("name", "=", name).execute();
  }

  /** Move a resource to a different organisation (e.g. on ownership transfer). */
  async setSiteOrg(name: string, orgId: string): Promise<void> {
    await this.db.updateTable("sites").set({ org_id: orgId, updated_at: sql`now()` }).where("name", "=", name).execute();
  }

  /** Total workloads (sites + apps + databases) owned by an org — the per-org cap is checked against this. */
  async countSitesInOrg(orgId: string): Promise<number> {
    const row = await this.db
      .selectFrom("sites")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** Workload counts by type for an org (usage reporting). */
  async orgWorkloadCounts(orgId: string): Promise<{ site: number; app: number; database: number; bucket: number; cache: number; auth: number; total: number }> {
    const rows = await this.db
      .selectFrom("sites")
      .select(["type", (eb) => eb.fn.countAll().as("n")])
      .where("org_id", "=", orgId)
      .groupBy("type")
      .execute();
    const out = { site: 0, app: 0, database: 0, bucket: 0, cache: 0, auth: 0, total: 0 };
    for (const r of rows) {
      const n = Number(r.n);
      out[(r.type as WorkloadType) ?? "site"] += n;
      out.total += n;
    }
    return out;
  }

  /** Names of an org's resources of one type (small lists: buckets/databases). Sorted. */
  async orgSiteNames(orgId: string, type: WorkloadType): Promise<string[]> {
    const rows = await this.db
      .selectFrom("sites")
      .select("name")
      .where("org_id", "=", orgId)
      .where("type", "=", type)
      .orderBy("name")
      .execute();
    return rows.map((r) => r.name);
  }

  /** The requested PVC storage of every database in an org (its current version's DatabaseConfig,
   *  defaulting to the platform default when a pre-item-10 row stored no config). Feeds the org
   *  storage-budget computation — approximate by design (it's the REQUEST, not live disk use). */
  async orgDatabaseStorageRequests(orgId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("sites")
      .leftJoin("versions", (j) => j.onRef("versions.site_name", "=", "sites.name").onRef("versions.id", "=", "sites.current_version"))
      .select(["sites.name as name", "versions.config as vconfig"])
      .where("sites.org_id", "=", orgId)
      .where("sites.type", "=", "database")
      .execute();
    return rows.map((r) => {
      const cfg = parseVersionCfg((r as Record<string, unknown>).vconfig) as { storage?: string } | undefined;
      return cfg && typeof cfg.storage === "string" ? cfg.storage : MAX_DB_STORAGE;
    });
  }

  /** (I2) The PVC storage of every PERSISTENT cache in an org (its current version's CacheConfig.memory,
   *  which sizes the PVC). Ephemeral caches have no PVC → contribute nothing. Feeds the org storage
   *  budget alongside orgDatabaseStorageRequests — approximate by design (it's the REQUEST). */
  async orgCacheStorageRequests(orgId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("sites")
      .leftJoin("versions", (j) => j.onRef("versions.site_name", "=", "sites.name").onRef("versions.id", "=", "sites.current_version"))
      .select(["sites.name as name", "versions.config as vconfig"])
      .where("sites.org_id", "=", orgId)
      .where("sites.type", "=", "cache")
      .execute();
    const out: string[] = [];
    for (const r of rows) {
      const cfg = parseVersionCfg((r as Record<string, unknown>).vconfig) as { memory?: string; persistent?: boolean } | undefined;
      if (cfg?.persistent && typeof cfg.memory === "string") out.push(cfg.memory);
    }
    return out;
  }

  /** (G2b) Every DEPLOYED workload the uptime poller may probe (sites/apps/databases with a current
   *  version). Joins the org for the namespace (DB TCP path) + the current version's config to surface
   *  an app's `scale.min` + `healthcheck.keep_warm` — the poller's scale-to-zero gating inputs. Bounded
   *  to the probeable types; the poller itself decides what actually gets probed (see probeKind). */
  async listUptimeTargets(): Promise<UptimeTarget[]> {
    const rows = await this.db
      .selectFrom("sites")
      .leftJoin("organisations", "organisations.id", "sites.org_id")
      .leftJoin("versions", (j) => j.onRef("versions.site_name", "=", "sites.name").onRef("versions.id", "=", "sites.current_version"))
      .select([
        "sites.name as name",
        "sites.type as type",
        "sites.runtime_state as runtime_state",
        "organisations.namespace as ns",
        "versions.config as vconfig",
      ])
      .where("sites.type", "in", ["site", "app", "database"])
      .where("sites.current_version", "is not", null)
      .execute();
    return rows.map((r) => {
      const cfg = parseVersionCfg((r as Record<string, unknown>).vconfig) as
        | { scale?: { min?: number }; healthcheck?: { keepWarm?: boolean } }
        | undefined;
      return {
        name: r.name as string,
        type: (r.type as WorkloadType) ?? "site",
        namespace: (r.ns as string | null) ?? null,
        runtimeState: ((r.runtime_state as string) ?? "running") === "stopped" ? "stopped" : "running",
        scaleMin: typeof cfg?.scale?.min === "number" ? cfg.scale.min : 0,
        keepWarm: cfg?.healthcheck?.keepWarm === true,
      };
    });
  }

  /** (G3) Whether a serving host had ANY edge traffic since `since` — used by the preview sweep to warn
   *  (emit `preview_expiring`) before reaping a preview that was actively in use. The traffic collector
   *  keys on the resolved HOST label, which for a preview is `<site>--<label>` (not FK-bound to a site).
   *  A cheap existence probe (LIMIT 1 over the `minute` index), not a sum. */
  async hadTrafficSince(host: string, since: Date): Promise<boolean> {
    const r = await this.db.selectFrom("traffic_minutes").select("site_name").where("site_name", "=", host).where("minute", ">=", since).limit(1).executeTakeFirst();
    return !!r;
  }

  /** (G3) Every RUNNING app with a resolved namespace — the crash-loop sweep's enumeration. Bounded to
   *  container workloads (`type='app'`) that are meant to be up (runtime_state='running'); the sweep
   *  groups these by namespace, reads live restart deltas, and emits/resolves crash-loop events. */
  async listAppsForCrashScan(): Promise<{ name: string; namespace: string; orgId: string }[]> {
    const rows = await this.db
      .selectFrom("sites")
      .innerJoin("organisations", "organisations.id", "sites.org_id")
      .select(["sites.name as name", "organisations.namespace as ns", "sites.org_id as org_id"])
      .where("sites.type", "=", "app")
      .where("sites.runtime_state", "=", "running")
      .execute();
    return rows.map((r) => ({ name: r.name as string, namespace: r.ns as string, orgId: r.org_id as string }));
  }

  // ---- (G4) searchable log retention: the `log_objects` index ----

  /** Every RUNNING, DEPLOYED workload the log collector may tail (apps + databases with a namespace and a
   *  current version). Surfaces the version config's `logRetention` opt-out/opt-in flag so the collector
   *  applies shouldCollectLogs (DBs off by default, apps/sites on). Bounded to the pod-backed types. */
  async listLogCollectionTargets(): Promise<{ name: string; type: WorkloadType; namespace: string; logRetention?: boolean }[]> {
    const rows = await this.db
      .selectFrom("sites")
      .innerJoin("organisations", "organisations.id", "sites.org_id")
      .leftJoin("versions", (j) => j.onRef("versions.site_name", "=", "sites.name").onRef("versions.id", "=", "sites.current_version"))
      .select(["sites.name as name", "sites.type as type", "organisations.namespace as ns", "versions.config as vconfig"])
      .where("sites.type", "in", ["app", "database"])
      .where("sites.runtime_state", "=", "running")
      .where("sites.current_version", "is not", null)
      .execute();
    return rows.map((r) => {
      const cfg = parseVersionCfg((r as Record<string, unknown>).vconfig) as { logRetention?: boolean } | undefined;
      return {
        name: r.name as string,
        type: (r.type as WorkloadType) ?? "app",
        namespace: r.ns as string,
        logRetention: typeof cfg?.logRetention === "boolean" ? cfg.logRetention : undefined,
      };
    });
  }

  /** Upsert the index row for a flushed log object. A flush REWRITES an hour's object with its full
   *  accumulated set, so the row upserts on (site, hour) with the current line/byte counts. */
  async insertLogObject(o: { siteName: string; hour: Date; key: string; lines: number; bytes: number }): Promise<void> {
    await this.db
      .insertInto("log_objects")
      .values({ site_name: o.siteName, hour: o.hour, key: o.key, lines: o.lines, bytes: o.bytes, created_at: sql`now()` })
      .onConflict((oc) => oc.columns(["site_name", "hour"]).doUpdateSet({ key: o.key, lines: o.lines, bytes: o.bytes }))
      .execute();
  }

  /** (search) The site's log objects whose hour bucket overlaps [from,to], NEWEST FIRST. Broadened by one
   *  hour on the `from` side so a bucket straddling the range's start is still scanned (its later records
   *  may fall in range); the per-record ts filter in searchLogObjects does the exact trimming. */
  async listLogObjectsInRange(site: string, from: Date, to: Date): Promise<{ hour: Date; key: string }[]> {
    const fromHour = new Date(from.getTime() - 3_600_000);
    const rows = await this.db
      .selectFrom("log_objects")
      .select(["hour", "key"])
      .where("site_name", "=", site)
      .where("hour", ">=", fromHour)
      .where("hour", "<=", to)
      .orderBy("hour", "desc")
      .execute();
    return rows.map((r) => ({ hour: r.hour instanceof Date ? r.hour : new Date(r.hour as unknown as string), key: r.key }));
  }

  /** (retention) Distinct sites that have log objects, each with its OWNING org id (null when the site was
   *  deleted — its rows survive here, no FK — so the sweep falls back to the platform default window). */
  async listLogObjectSites(): Promise<{ siteName: string; orgId: string | null }[]> {
    const rows = await this.db
      .selectFrom("log_objects")
      .leftJoin("sites", "sites.name", "log_objects.site_name")
      .select(["log_objects.site_name as site_name", "sites.org_id as org_id"])
      .distinct()
      .execute();
    return rows.map((r) => ({ siteName: r.site_name as string, orgId: (r.org_id as string | null) ?? null }));
  }

  /** (retention) A site's log objects older than the cutoff — the set the sweep deletes (S3 then row). */
  async listLogObjectsBefore(site: string, cutoff: Date): Promise<{ hour: Date; key: string }[]> {
    const rows = await this.db
      .selectFrom("log_objects")
      .select(["hour", "key"])
      .where("site_name", "=", site)
      .where("hour", "<", cutoff)
      .execute();
    return rows.map((r) => ({ hour: r.hour instanceof Date ? r.hour : new Date(r.hour as unknown as string), key: r.key }));
  }

  /** (retention) Drop one index row after its S3 object is deleted. Idempotent (a no-op if already gone). */
  async deleteLogObject(site: string, hour: Date): Promise<void> {
    await this.db.deleteFrom("log_objects").where("site_name", "=", site).where("hour", "=", hour).execute();
  }
}
