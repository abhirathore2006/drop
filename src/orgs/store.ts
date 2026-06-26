// Organisations: a logical group that owns resources, with org-level roles. The single seam over
// org metadata. Personal orgs reuse the user's existing tenant namespace (so backfill moves no
// workload); team orgs get their own. Per-resource site_members survive as an additive grant layer.
import { sql } from "kysely";
import { createHash, randomBytes } from "node:crypto";
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
   *  (so it equals where their existing workloads already run) and is NEVER randomized. The id is
   *  deterministic from the email → idempotent + race-safe. The slug carries a fresh RANDOM suffix
   *  so it can't collide with a team org that squatted the namespace-derived name; on a slug
   *  collision we regenerate the suffix and retry. */
  async ensurePersonalOrg(email: string): Promise<Org> {
    const e = email.toLowerCase();
    const id = personalId(e);
    const found = await this.db.selectFrom("organisations").selectAll().where("id", "=", id).executeTakeFirst();
    if (found) return this.toOrg(found); // already created (with its original slug) → idempotent
    const ns = tenantNamespace(e); // load-bearing invariant: reuse the existing tenant namespace
    const base = e.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32); // DNS-safe, recognizable
    const ensureMembership = () =>
      this.db.insertInto("org_members").values({ org_id: id, email: e, role: "owner" })
        .onConflict((oc) => oc.columns(["org_id", "email"]).doNothing()).execute();
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = `${base}-${randomBytes(4).toString("hex")}`; // base-<8 hex>, fresh each attempt
      const inserted = await this.db
        .insertInto("organisations")
        .values({ id, slug, name: e, kind: "personal", namespace: ns, created_by: e })
        .onConflict((oc) => oc.doNothing()) // ANY unique violation (id race OR slug squat) → no row
        .returningAll()
        .executeTakeFirst();
      if (inserted) {
        await ensureMembership();
        return this.toOrg(inserted);
      }
      // No row inserted: did OUR id win a concurrent race, or did the slug collide with another org?
      const byId = await this.db.selectFrom("organisations").selectAll().where("id", "=", id).executeTakeFirst();
      if (byId) {
        await ensureMembership(); // a concurrent call created our personal org → adopt it
        return this.toOrg(byId);
      }
      // else: the slug collided with a DIFFERENT org → loop regenerates the random suffix and retries
    }
    throw new Error(`ensurePersonalOrg: could not allocate a unique slug for ${e} after 5 attempts`);
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
  /** Every org (platform-admin browse). Team orgs first, then personal, each alphabetical by name. */
  async listAllOrgs(): Promise<Org[]> {
    const rows = await this.db
      .selectFrom("organisations")
      .selectAll()
      .orderBy("kind", "desc") // 'team' > 'personal' → team first
      .orderBy("name")
      .execute();
    return rows.map((r) => this.toOrg(r as Record<string, unknown>));
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
