// The single seam over template metadata (Postgres): the `templates` catalog row and its immutable
// `template_versions`. CRUD + latest-version resolve + VISIBILITY-AWARE listing. Ids are deterministic
// from the slug (`tpl_<hash>`) — the slug is UNIQUE instance-wide (the golden-path namespace), so the id
// is stable and the "does this slug exist" check is one point read. Versions are monotonic integers-as-
// text ("1","2",…); republishing a slug appends a new version (never mutates an existing one).
import { createHash } from "node:crypto";
import type { Db } from "../db/db.ts";
import type { StackSpec } from "../stack-config.ts";
import type { TemplateVisibility } from "../db/schema.ts";
import type { TemplateVariable } from "./vars.ts";

/** A template slug: the golden-path `drop new <slug>` namespace. 3–40 chars, DNS-label shaped. */
const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export function validateTemplateSlug(slug: unknown): string | null {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return "template slug must be 3–40 chars, lowercase a–z/0–9/-, start with a letter";
  return null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const parseSpec = (v: unknown): StackSpec => (typeof v === "string" ? (JSON.parse(v) as StackSpec) : (v as StackSpec));
const parseVars = (v: unknown): TemplateVariable[] => {
  const a = typeof v === "string" ? JSON.parse(v) : v;
  return Array.isArray(a) ? (a as TemplateVariable[]) : [];
};

export interface TemplateRow {
  id: string;
  slug: string;
  orgId: string;
  name: string;
  description: string | null;
  visibility: TemplateVisibility;
  createdBy: string;
  createdAt: string;
}

export interface TemplateVersionRow {
  templateId: string;
  version: string;
  spec: StackSpec;
  variables: TemplateVariable[];
  readme: string | null;
  createdBy: string;
  createdAt: string;
}

/** A template row joined with its LATEST version's summary (for the list view). */
export interface TemplateListItem extends TemplateRow {
  latestVersion: string | null;
  resources: number;
}

export class TemplateStore {
  constructor(private db: Db) {}

  templateId(slug: string): string {
    return "tpl_" + createHash("sha256").update(slug.toLowerCase()).digest("hex").slice(0, 20);
  }

  private toRow(r: Record<string, unknown>): TemplateRow {
    return {
      id: r.id as string,
      slug: r.slug as string,
      orgId: r.org_id as string,
      name: r.name as string,
      description: (r.description as string | null) ?? null,
      visibility: r.visibility as TemplateVisibility,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at),
    };
  }
  private toVersion(r: Record<string, unknown>): TemplateVersionRow {
    return {
      templateId: r.template_id as string,
      version: r.version as string,
      spec: parseSpec(r.spec),
      variables: parseVars(r.variables),
      readme: (r.readme as string | null) ?? null,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at),
    };
  }

  async getBySlug(slug: string): Promise<TemplateRow | null> {
    const r = await this.db.selectFrom("templates").selectAll().where("slug", "=", slug).executeTakeFirst();
    return r ? this.toRow(r) : null;
  }

  /** The highest version number (as an int), or 0 when none exist yet. */
  private async maxVersion(templateId: string): Promise<number> {
    const rows = await this.db.selectFrom("template_versions").select("version").where("template_id", "=", templateId).execute();
    let max = 0;
    for (const r of rows) {
      const n = parseInt(r.version, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  /**
   * Publish: create-or-refresh the `templates` row for `slug`, then append a new immutable version.
   * Refreshes name/description/visibility from the publish (the catalog card follows the latest publish).
   * Returns the template + the new version. The caller has already validated org create-rights.
   */
  async publish(opts: {
    slug: string;
    orgId: string;
    name: string;
    description?: string | null;
    visibility: TemplateVisibility;
    spec: StackSpec;
    variables: TemplateVariable[];
    readme?: string | null;
    createdBy: string;
  }): Promise<{ template: TemplateRow; version: TemplateVersionRow }> {
    const id = this.templateId(opts.slug);
    const by = opts.createdBy.toLowerCase();
    await this.db
      .insertInto("templates")
      .values({ id, slug: opts.slug, org_id: opts.orgId, name: opts.name, description: opts.description ?? null, visibility: opts.visibility, created_by: by })
      .onConflict((oc) => oc.column("id").doUpdateSet({ name: opts.name, description: opts.description ?? null, visibility: opts.visibility }))
      .execute();
    const template = (await this.getBySlug(opts.slug))!;
    const version = String((await this.maxVersion(id)) + 1);
    const vr = await this.db
      .insertInto("template_versions")
      .values({ template_id: id, version, spec: JSON.stringify(opts.spec), variables: JSON.stringify(opts.variables), readme: opts.readme ?? null, created_by: by })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { template, version: this.toVersion(vr) };
  }

  async getVersion(templateId: string, version: string): Promise<TemplateVersionRow | null> {
    const r = await this.db.selectFrom("template_versions").selectAll().where("template_id", "=", templateId).where("version", "=", version).executeTakeFirst();
    return r ? this.toVersion(r) : null;
  }

  async latestVersion(templateId: string): Promise<TemplateVersionRow | null> {
    const max = await this.maxVersion(templateId);
    return max === 0 ? null : this.getVersion(templateId, String(max));
  }

  /** Resolve a template by slug + optional version (latest when omitted). */
  async resolve(slug: string, version?: string | null): Promise<{ template: TemplateRow; version: TemplateVersionRow } | null> {
    const template = await this.getBySlug(slug);
    if (!template) return null;
    const v = version ? await this.getVersion(template.id, version) : await this.latestVersion(template.id);
    if (!v) return null;
    return { template, version: v };
  }

  /** All versions of a template, newest first (for `?versions` / a version picker). */
  async versions(templateId: string): Promise<TemplateVersionRow[]> {
    const rows = await this.db.selectFrom("template_versions").selectAll().where("template_id", "=", templateId).execute();
    return rows.map((r) => this.toVersion(r as Record<string, unknown>)).sort((a, b) => parseInt(b.version, 10) - parseInt(a.version, 10));
  }

  /**
   * Visibility-aware listing: every `public` template (instance-wide) PLUS every `org` template whose
   * org is in `memberOrgIds` (the caller's memberships). Each item carries its latest version's summary.
   */
  async listVisible(memberOrgIds: string[]): Promise<TemplateListItem[]> {
    let q = this.db.selectFrom("templates").selectAll();
    q = q.where((eb) =>
      eb.or([eb("visibility", "=", "public"), memberOrgIds.length ? eb("org_id", "in", memberOrgIds) : eb.val(false)]),
    );
    const rows = await q.orderBy("name").execute();
    const out: TemplateListItem[] = [];
    for (const r of rows) {
      const t = this.toRow(r as Record<string, unknown>);
      const latest = await this.latestVersion(t.id);
      out.push({ ...t, latestVersion: latest?.version ?? null, resources: latest ? Object.keys(latest.spec.resources).length : 0 });
    }
    return out;
  }

  /** Can `email` (a member of `memberOrgIds`) SEE this template? Public = always; org = must be a member. */
  canView(template: TemplateRow, memberOrgIds: string[]): boolean {
    return template.visibility === "public" || memberOrgIds.includes(template.orgId);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("templates").where("id", "=", id).execute(); // cascades template_versions
  }
}
