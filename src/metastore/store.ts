import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import type { SiteConfig } from "../site-config.ts";
import {
  type Member,
  type Site,
  type SitePointer,
  type Visibility,
  type VersionMeta,
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
      owner,
      members,
      collaborators: members.filter((m) => m.role !== "owner").map((m) => m.email),
      currentVersion: (row.current_version as string | null) ?? null,
      visibility: row.visibility as Visibility,
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

  /** Atomic claim: insert site + owner membership in one tx. Null if name taken. */
  async claimSite(name: string, owner: string): Promise<Site | null> {
    return await this.db.transaction().execute(async (tx) => {
      const site = await tx
        .insertInto("sites")
        .values({ name, updated_at: sql`now()` })
        .onConflict((oc) => oc.column("name").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!site) return null; // already claimed
      await tx.insertInto("site_members").values({ site_name: name, email: owner, role: "owner" }).execute();
      return this.toSite(site, [{ email: owner, role: "owner" }]);
    });
  }

  async getSitePlain(name: string): Promise<Site | null> {
    const row = await this.db.selectFrom("sites").selectAll().where("name", "=", name).executeTakeFirst();
    if (!row) return null;
    return this.toSite(row, await this.membersOf(name));
  }

  /** Lean edge read: pointer + visibility + password + config (no member list). */
  async getPointer(name: string): Promise<SitePointer | null> {
    const row = await this.db
      .selectFrom("sites")
      .select(["current_version", "visibility", "password_hash", "config"])
      .where("name", "=", name)
      .executeTakeFirst();
    if (!row) return null;
    return {
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

  /** Names of sites a user owns or collaborates on. */
  async listUserSites(email: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("site_members")
      .select("site_name")
      .where("email", "=", email)
      .orderBy("site_name")
      .execute();
    return rows.map((r) => r.site_name);
  }

  /** Keyset page over all sites (admin browse), optional name prefix. */
  async listSitesPage(
    opts: { cursor?: string; limit?: number; prefix?: string } = {},
  ): Promise<{ names: string[]; nextCursor?: string }> {
    const limit = opts.limit ?? 100;
    let q = this.db.selectFrom("sites").select("name").orderBy("name").limit(limit + 1);
    if (opts.cursor) q = q.where("name", ">", opts.cursor);
    if (opts.prefix) q = q.where("name", "like", opts.prefix.replace(/[%_\\]/g, "\\$&") + "%");
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
}
