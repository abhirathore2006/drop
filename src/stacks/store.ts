// The single seam over stack metadata (Postgres): the `stacks` row (name/org/spec/spec_version +
// provenance) and its `stack_resources` key→site_name mapping. CRUD only — the diff/plan lives in
// plan.ts (pure) and the reconcile lives in the API route. Ids are deterministic from (org_id, name)
// so the advisory-lock key `stack:<id>` is known before the row is written (mirrors OrgStore's ids).
import { sql } from "kysely";
import { createHash } from "node:crypto";
import type { Db } from "../db/db.ts";
import type { StackSpec } from "../stack-config.ts";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const parseSpec = (v: unknown): StackSpec => (typeof v === "string" ? (JSON.parse(v) as StackSpec) : (v as StackSpec));

/** A stack record (row + parsed spec). */
export interface StackRow {
  id: string;
  name: string;
  orgId: string;
  spec: StackSpec;
  specVersion: number;
  fromTemplate: string | null;
  fromTemplateVersion: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface StackResourceMap {
  resourceKey: string;
  siteName: string;
}

/** A resource mapping row across ALL envs of a stack (the cascade-delete / all-env view). */
export interface StackResourceEnvMap extends StackResourceMap {
  env: string;
}

/** (E3) One environment row — a named, durable instantiation with its own variable overlay. */
export interface EnvironmentRow {
  stackId: string;
  name: string;
  variables: Record<string, string>;
  createdBy: string;
  createdAt: string;
}

export class StackStore {
  constructor(private db: Db) {}

  /** Deterministic id from (org, name) — stable across replicas, so the lock key exists pre-insert. */
  stackId(orgId: string, name: string): string {
    return "stk_" + createHash("sha256").update(`${orgId}:${name}`).digest("hex").slice(0, 20);
  }

  private toRow(r: Record<string, unknown>): StackRow {
    return {
      id: r.id as string,
      name: r.name as string,
      orgId: r.org_id as string,
      spec: parseSpec(r.spec),
      specVersion: Number(r.spec_version ?? 1),
      fromTemplate: (r.from_template as string | null) ?? null,
      fromTemplateVersion: (r.from_template_version as string | null) ?? null,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async getByName(orgId: string, name: string): Promise<StackRow | null> {
    const r = await this.db.selectFrom("stacks").selectAll().where("org_id", "=", orgId).where("name", "=", name).executeTakeFirst();
    return r ? this.toRow(r) : null;
  }

  async getById(id: string): Promise<StackRow | null> {
    const r = await this.db.selectFrom("stacks").selectAll().where("id", "=", id).executeTakeFirst();
    return r ? this.toRow(r) : null;
  }

  /** Create a stack row (id deterministic from org+name). Throws on a name collision within the org. */
  async create(opts: {
    name: string;
    orgId: string;
    spec: StackSpec;
    createdBy: string;
    fromTemplate?: string | null;
    fromTemplateVersion?: string | null;
  }): Promise<StackRow> {
    const id = this.stackId(opts.orgId, opts.name);
    const r = await this.db
      .insertInto("stacks")
      .values({
        id,
        name: opts.name,
        org_id: opts.orgId,
        spec: JSON.stringify(opts.spec),
        spec_version: 1,
        from_template: opts.fromTemplate ?? null,
        from_template_version: opts.fromTemplateVersion ?? null,
        created_by: opts.createdBy.toLowerCase(),
        updated_at: sql`now()`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toRow(r);
  }

  /** Replace the desired spec and bump spec_version → the new value (optimistic-concurrency cursor). */
  async updateSpec(id: string, spec: StackSpec, nextVersion: number): Promise<void> {
    await this.db
      .updateTable("stacks")
      .set({ spec: JSON.stringify(spec), spec_version: nextVersion, updated_at: sql`now()` })
      .where("id", "=", id)
      .execute();
  }

  /** (D2) Re-pin the template provenance version after a successful `stack.upgrade` to the target. */
  async setProvenanceVersion(id: string, fromTemplateVersion: string): Promise<void> {
    await this.db
      .updateTable("stacks")
      .set({ from_template_version: fromTemplateVersion, updated_at: sql`now()` })
      .where("id", "=", id)
      .execute();
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("stacks").where("id", "=", id).execute(); // cascades stack_resources
  }

  /** Stacks in an org, newest updated first. */
  async listByOrg(orgId: string): Promise<StackRow[]> {
    const rows = await this.db.selectFrom("stacks").selectAll().where("org_id", "=", orgId).orderBy("name").execute();
    return rows.map((r) => this.toRow(r as Record<string, unknown>));
  }

  /** Stacks across several orgs (the caller's memberships) — the `drop stack ls` backing query. */
  async listByOrgs(orgIds: string[]): Promise<StackRow[]> {
    if (orgIds.length === 0) return [];
    const rows = await this.db.selectFrom("stacks").selectAll().where("org_id", "in", orgIds).orderBy("name").execute();
    return rows.map((r) => this.toRow(r as Record<string, unknown>));
  }

  // ---- resource mapping ((env, resource_key) -> site_name) ----
  // (E3) The mapping is keyed by (stack_id, env, resource_key). `env` is '' for the unnamed default env
  // (backward compatible: existing rows carry the '' default), and the named env's DNS-safe label otherwise.

  /** The resources of ONE environment (default env when `env` omitted). */
  async resources(stackId: string, env = ""): Promise<StackResourceMap[]> {
    const rows = await this.db
      .selectFrom("stack_resources")
      .select(["resource_key", "site_name"])
      .where("stack_id", "=", stackId)
      .where("env", "=", env)
      .orderBy("resource_key")
      .execute();
    return rows.map((r) => ({ resourceKey: r.resource_key, siteName: r.site_name }));
  }

  /** Every resource across EVERY env of the stack (the stack-delete cascade view). */
  async allResources(stackId: string): Promise<StackResourceEnvMap[]> {
    const rows = await this.db
      .selectFrom("stack_resources")
      .select(["env", "resource_key", "site_name"])
      .where("stack_id", "=", stackId)
      .orderBy("env")
      .orderBy("resource_key")
      .execute();
    return rows.map((r) => ({ env: r.env, resourceKey: r.resource_key, siteName: r.site_name }));
  }

  /** key → site_name mapping for ONE env (the planner's `mapping` input). */
  async mapping(stackId: string, env = ""): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of await this.resources(stackId, env)) out[r.resourceKey] = r.siteName;
    return out;
  }

  /** Record (or refresh) a materialized resource in an env. */
  async setResource(stackId: string, env: string, resourceKey: string, siteName: string): Promise<void> {
    await this.db
      .insertInto("stack_resources")
      .values({ stack_id: stackId, env, resource_key: resourceKey, site_name: siteName })
      .onConflict((oc) => oc.columns(["stack_id", "env", "resource_key"]).doUpdateSet({ site_name: siteName }))
      .execute();
  }

  async deleteResource(stackId: string, env: string, resourceKey: string): Promise<void> {
    await this.db.deleteFrom("stack_resources").where("stack_id", "=", stackId).where("env", "=", env).where("resource_key", "=", resourceKey).execute();
  }
}

/** (E3) The seam over `environments` — a stack's named, durable variable overlays. CRUD only; the
 *  reconcile (substitute + up) lives in the API route, mirroring how StackStore/plan.ts split. */
export class EnvironmentStore {
  constructor(private db: Db) {}

  private toRow(r: Record<string, unknown>): EnvironmentRow {
    const v = r.variables;
    const variables = typeof v === "string" ? (JSON.parse(v) as Record<string, string>) : ((v as Record<string, string>) ?? {});
    return {
      stackId: r.stack_id as string,
      name: r.name as string,
      variables,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at),
    };
  }

  /** All named environments of a stack, alphabetical. (The default env '' is implicit — no row.) */
  async list(stackId: string): Promise<EnvironmentRow[]> {
    const rows = await this.db.selectFrom("environments").selectAll().where("stack_id", "=", stackId).orderBy("name").execute();
    return rows.map((r) => this.toRow(r as Record<string, unknown>));
  }

  async get(stackId: string, name: string): Promise<EnvironmentRow | null> {
    const r = await this.db.selectFrom("environments").selectAll().where("stack_id", "=", stackId).where("name", "=", name).executeTakeFirst();
    return r ? this.toRow(r) : null;
  }

  /** Create an env row. Throws on a duplicate (stack_id, name). */
  async create(opts: { stackId: string; name: string; variables: Record<string, string>; createdBy: string }): Promise<EnvironmentRow> {
    const r = await this.db
      .insertInto("environments")
      .values({ stack_id: opts.stackId, name: opts.name, variables: JSON.stringify(opts.variables ?? {}), created_by: opts.createdBy.toLowerCase() })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toRow(r);
  }

  async delete(stackId: string, name: string): Promise<void> {
    await this.db.deleteFrom("environments").where("stack_id", "=", stackId).where("name", "=", name).execute();
  }
}
