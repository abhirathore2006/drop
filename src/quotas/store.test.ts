import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { QuotaStore, validateQuota, parseByteSize } from "./store.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@x.com");
  return { db, quotas: new QuotaStore(db), orgId: org.id };
}

test("parseByteSize: bare integer OR k8s quantity; else null", () => {
  expect(parseByteSize("1048576")).toBe(1048576);
  expect(parseByteSize("10Gi")).toBe(10 * 2 ** 30);
  expect(parseByteSize("512Mi")).toBe(512 * 2 ** 20);
  expect(parseByteSize("nonsense")).toBeNull();
});

test("validateQuota: per-key rules; unknown key rejected", () => {
  expect(validateQuota("max_workloads", "5")).toBeNull();
  expect(validateQuota("max_workloads", "-1")).toMatch(/non-negative integer/);
  expect(validateQuota("max_db_storage", "5Gi")).toBeNull();
  expect(validateQuota("max_db_storage", "5 gigs")).toMatch(/k8s quantity/);
  expect(validateQuota("storage_budget_bytes", "10Gi")).toBeNull();
  expect(validateQuota("storage_budget_bytes", "99")).toBeNull();
  expect(validateQuota("storage_budget_bytes", "big")).toMatch(/byte count/);
  expect(validateQuota("nope", "1")).toMatch(/unknown quota key/);
});

test("resolvers fall back to the platform default until an override is set", async () => {
  const { db, quotas, orgId } = await fix();
  // defaults
  expect(await quotas.resolvedMaxWorkloads(orgId, 3)).toBe(3);
  expect(await quotas.resolvedMaxDbStorage(orgId)).toEqual({ label: "1Gi", bytes: 2 ** 30 });
  expect(await quotas.resolvedStorageBudgetBytes(orgId)).toBeNull();

  // overrides win
  await quotas.set(orgId, "max_workloads", "10", "alice@x.com");
  await quotas.set(orgId, "max_db_storage", "5Gi", "alice@x.com");
  await quotas.set(orgId, "storage_budget_bytes", "10Gi", "alice@x.com");
  expect(await quotas.resolvedMaxWorkloads(orgId, 3)).toBe(10);
  expect(await quotas.resolvedMaxDbStorage(orgId)).toEqual({ label: "5Gi", bytes: 5 * 2 ** 30 });
  expect(await quotas.resolvedStorageBudgetBytes(orgId)).toBe(10 * 2 ** 30);

  // set is upsert; list reflects the current overrides
  await quotas.set(orgId, "max_workloads", "20", "bob@x.com");
  expect(await quotas.resolvedMaxWorkloads(orgId, 3)).toBe(20);
  const list = await quotas.list(orgId);
  expect(list.map((r) => r.key).sort()).toEqual(["max_db_storage", "max_workloads", "storage_budget_bytes"]);
  expect(list.find((r) => r.key === "max_workloads")!.updatedBy).toBe("bob@x.com");

  await db.destroy();
});
