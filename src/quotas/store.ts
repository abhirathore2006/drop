// Per-org quota overrides (Future.md item 10, API level). A thin store over `org_quotas` plus the
// RESOLVERS that fold an override together with the platform default. An absent override means "use
// the default" — the config workload cap (`maxWorkloadsPerOrg`) or the `MAX_DB_STORAGE` per-database
// ceiling. Keys v1: `max_workloads`, `max_db_storage`, `storage_budget_bytes`.
import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import { MAX_DB_STORAGE, storageToBytes } from "../db-config.ts";

export type QuotaKey = "max_workloads" | "max_db_storage" | "storage_budget_bytes";
export const QUOTA_KEYS: readonly QuotaKey[] = ["max_workloads", "max_db_storage", "storage_budget_bytes"];

export interface QuotaOverride {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: string; // ISO
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Parse a byte budget: a bare integer (bytes) OR a k8s binary-SI quantity ("10Gi"). Null if neither. */
export function parseByteSize(v: string): number | null {
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  return storageToBytes(v.trim());
}

/** Validate a quota key+value at the admin boundary. Returns an error string, or null when acceptable. */
export function validateQuota(key: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "value must be a non-empty string";
  if (key === "max_workloads") {
    return /^\d+$/.test(value) ? null : "max_workloads must be a non-negative integer (0 = unlimited)";
  }
  if (key === "max_db_storage") {
    return storageToBytes(value) != null ? null : "max_db_storage must be a k8s quantity like 512Mi, 1Gi, or 5Gi";
  }
  if (key === "storage_budget_bytes") {
    return parseByteSize(value) != null ? null : "storage_budget_bytes must be a byte count or a k8s quantity like 10Gi";
  }
  return `unknown quota key "${key}" (allowed: ${QUOTA_KEYS.join(", ")})`;
}

export class QuotaStore {
  constructor(private db: Db) {}

  async get(orgId: string, key: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("org_quotas")
      .select("value")
      .where("org_id", "=", orgId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  async set(orgId: string, key: string, value: string, updatedBy: string): Promise<void> {
    await this.db
      .insertInto("org_quotas")
      .values({ org_id: orgId, key, value, updated_by: updatedBy, updated_at: sql`now()` })
      .onConflict((oc) => oc.columns(["org_id", "key"]).doUpdateSet({ value, updated_by: updatedBy, updated_at: sql`now()` }))
      .execute();
  }

  async list(orgId: string): Promise<QuotaOverride[]> {
    const rows = await this.db.selectFrom("org_quotas").selectAll().where("org_id", "=", orgId).orderBy("key").execute();
    return rows.map((r) => ({ key: r.key, value: r.value, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) }));
  }

  // ---- resolvers: override, else platform default ----

  /** The per-org workload cap (0 = unlimited). Override → config default (`maxWorkloadsPerOrg`). */
  async resolvedMaxWorkloads(orgId: string, cfgDefault: number): Promise<number> {
    const v = await this.get(orgId, "max_workloads");
    if (v == null) return cfgDefault;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : cfgDefault;
  }

  /** The per-database PVC storage cap. Override → the `MAX_DB_STORAGE` (1Gi) default. Both label
   *  (for error messages / the sanitizer) and bytes (for validation). */
  async resolvedMaxDbStorage(orgId: string): Promise<{ label: string; bytes: number }> {
    const v = await this.get(orgId, "max_db_storage");
    if (v) {
      const b = storageToBytes(v);
      if (b != null) return { label: v, bytes: b };
    }
    return { label: MAX_DB_STORAGE, bytes: storageToBytes(MAX_DB_STORAGE)! };
  }

  /** The org-wide storage budget in bytes, or null when unset (no budget enforced). */
  async resolvedStorageBudgetBytes(orgId: string): Promise<number | null> {
    const v = await this.get(orgId, "storage_budget_bytes");
    if (v == null) return null;
    return parseByteSize(v);
  }
}
