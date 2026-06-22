// Organisations: a logical group that owns resources, with org-level roles. The single seam over
// org metadata. Personal orgs reuse the user's existing tenant namespace (so backfill moves no
// workload); team orgs get their own. Per-resource site_members survive as an additive grant layer.
import { sql } from "kysely";
import { createHash } from "node:crypto";
import type { Db } from "../db/db.ts";
import type { OrgKind, OrgRole } from "../db/schema.ts";
import { tenantNamespace, orgSlugNamespace } from "../api/tenant.ts";

export interface Org {
  id: string;
  slug: string;
  name: string;
  kind: OrgKind;
  namespace: string;
  createdBy: string;
  createdAt: string;
}
export interface OrgMember {
  email: string;
  role: OrgRole;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const personalId = (email: string) => "org_" + createHash("sha256").update("personal:" + email.toLowerCase()).digest("hex").slice(0, 20);
const teamId = (slug: string) => "org_" + createHash("sha256").update("team:" + slug.toLowerCase()).digest("hex").slice(0, 20);

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED = new Set(["personal", "admin", "api", "drop", "org", "orgs", "system", "default", "kube-system"]);
/** Validate a TEAM org slug. Returns an error string, or null if acceptable. */
export function validateOrgSlug(slug: unknown): string | null {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return "slug must be 3–40 chars, lowercase a–z/0–9/-, start with a letter";
  if (RESERVED.has(slug)) return `"${slug}" is reserved`;
  return null;
}

export class OrgStore {
  constructor(private db: Db) {}

  private toOrg(r: Record<string, unknown>): Org {
    return {
      id: r.id as string,
      slug: r.slug as string,
      name: r.name as string,
      kind: r.kind as OrgKind,
      namespace: r.namespace as string,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at),
    };
  }

  /** Idempotent: ensure the user's personal org exists. namespace = their LITERAL tenant namespace
   *  (so it equals where their existing workloads already run). Deterministic id → race-safe. */
  async ensurePersonalOrg(email: string): Promise<Org> {
    const e = email.toLowerCase();
    const id = personalId(e);
    const found = await this.db.selectFrom("organisations").selectAll().where("id", "=", id).executeTakeFirst();
    if (found) return this.toOrg(found);
    const ns = tenantNamespace(e);
    await this.db
      .insertInto("organisations")
      .values({ id, slug: ns.replace(/^drop-t-/, ""), name: e, kind: "personal", namespace: ns, created_by: e })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await this.db.insertInto("org_members").values({ org_id: id, email: e, role: "owner" }).onConflict((oc) => oc.columns(["org_id", "email"]).doNothing()).execute();
    return this.toOrg(await this.db.selectFrom("organisations").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
  }

  /** Create a TEAM org (creator becomes owner). Throws if the slug is taken. */
  async createOrg(slug: string, name: string, createdBy: string): Promise<Org> {
    const e = createdBy.toLowerCase();
    const id = teamId(slug);
    return await this.db.transaction().execute(async (tx) => {
      const org = await tx
        .insertInto("organisations")
        .values({ id, slug, name: name || slug, kind: "team", namespace: orgSlugNamespace(slug), created_by: e })
        .returningAll()
        .executeTakeFirst(); // unique(slug) → throws on dup
      if (!org) throw new Error("org slug already taken");
      await tx.insertInto("org_members").values({ org_id: id, email: e, role: "owner" }).execute();
      return this.toOrg(org);
    });
  }

  async getOrg(id: string): Promise<Org | null> {
    const r = await this.db.selectFrom("organisations").selectAll().where("id", "=", id).executeTakeFirst();
    return r ? this.toOrg(r) : null;
  }
  async getOrgBySlug(slug: string): Promise<Org | null> {
    const r = await this.db.selectFrom("organisations").selectAll().where("slug", "=", slug).executeTakeFirst();
    return r ? this.toOrg(r) : null;
  }
  /** Orgs the user is a member of, with their role. */
  async listUserOrgs(email: string): Promise<(Org & { role: OrgRole })[]> {
    const rows = await this.db
      .selectFrom("org_members")
      .innerJoin("organisations", "organisations.id", "org_members.org_id")
      .selectAll("organisations")
      .select("org_members.role as role")
      .where("org_members.email", "=", email.toLowerCase())
      .orderBy("organisations.kind") // personal first ('personal' < 'team')
      .execute();
    return rows.map((r) => ({ ...this.toOrg(r as Record<string, unknown>), role: (r as { role: OrgRole }).role }));
  }
  async members(orgId: string): Promise<OrgMember[]> {
    const rows = await this.db.selectFrom("org_members").select(["email", "role"]).where("org_id", "=", orgId).execute();
    return rows.map((r) => ({ email: r.email, role: r.role }));
  }
  /** The actor's role in an org, or null if not a member. */
  async roleOf(orgId: string | null, email: string): Promise<OrgRole | null> {
    if (!orgId) return null;
    const r = await this.db.selectFrom("org_members").select("role").where("org_id", "=", orgId).where("email", "=", email.toLowerCase()).executeTakeFirst();
    return r?.role ?? null;
  }
  async addMember(orgId: string, email: string, role: OrgRole): Promise<void> {
    await this.db
      .insertInto("org_members")
      .values({ org_id: orgId, email: email.toLowerCase(), role })
      .onConflict((oc) => oc.columns(["org_id", "email"]).doUpdateSet({ role }))
      .execute();
  }
  async removeMember(orgId: string, email: string): Promise<void> {
    await this.db.deleteFrom("org_members").where("org_id", "=", orgId).where("email", "=", email.toLowerCase()).execute();
  }
  /** Count resources owned by an org (block delete while non-empty). */
  async resourceCount(orgId: string): Promise<number> {
    const r = await this.db.selectFrom("sites").select(sql<number>`count(*)::int`.as("n")).where("org_id", "=", orgId).executeTakeFirst();
    return r?.n ?? 0;
  }
}
