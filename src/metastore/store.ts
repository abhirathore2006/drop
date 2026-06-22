import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import type { SiteConfig } from "../site-config.ts";
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

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const parseCfg = (v: unknown): SiteConfig | undefined =>
  v == null ? undefined : typeof v === "string" ? (JSON.parse(v) as SiteConfig) : (v as SiteConfig);
const encCfg = (c?: SiteConfig): string | null => (c ? JSON.stringify(c) : null);

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

  /** Keyset page over all sites (admin browse), optional name prefix / owner / type filters. */
  async listSitesPage(
    opts: { cursor?: string; limit?: number; prefix?: string; owner?: string; type?: WorkloadType } = {},
  ): Promise<{ names: string[]; nextCursor?: string }> {
    const limit = opts.limit ?? 100;
    let q = this.db.selectFrom("sites").select("name").orderBy("name").limit(limit + 1);
    if (opts.cursor) q = q.where("name", ">", opts.cursor);
    if (opts.prefix) q = q.where("name", "like", opts.prefix.replace(/[%_\\]/g, "\\$&") + "%");
    if (opts.type) q = q.where("type", "=", opts.type);
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
      config: parseCfg(r.config),
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
}
