import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore, validateOrgSlug } from "./store.ts";
import { tenantNamespace } from "../api/tenant.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  for (const e of ["alice@x.com", "bob@paytm.com", "a.very.long.email.address.that.exceeds@example.com"]) await users.upsertOnLogin(e, null);
  return { db, orgs: new OrgStore(db) };
}

test("ensurePersonalOrg: namespace == the user's literal tenant namespace (no workload moves), idempotent", async () => {
  const { db, orgs } = await fix();
  for (const e of ["alice@x.com", "bob@paytm.com", "a.very.long.email.address.that.exceeds@example.com"]) {
    const o = await orgs.ensurePersonalOrg(e);
    expect(o.kind).toBe("personal");
    expect(o.namespace).toBe(tenantNamespace(e)); // the load-bearing invariant: reuse the existing namespace
    const again = await orgs.ensurePersonalOrg(e);
    expect(again.id).toBe(o.id); // idempotent — never a second personal org
    expect((await orgs.roleOf(o.id, e))).toBe("owner");
  }
  await db.destroy();
});

test("ensurePersonalOrg: survives a slug squat (random suffix) — would have thrown on the old deterministic slug", async () => {
  const { db, orgs } = await fix();
  // Pre-occupy the OLD deterministic personal slug (namespace minus `drop-t-`) with another org.
  // The pre-fix code derived bob's personal slug from exactly this value → unique(slug) violation.
  const squatted = tenantNamespace("bob@paytm.com").replace(/^drop-t-/, "");
  await orgs.createOrg(squatted, "Squatter", "alice@x.com");
  const o = await orgs.ensurePersonalOrg("bob@paytm.com"); // must NOT throw
  expect(o.kind).toBe("personal");
  expect(o.namespace).toBe(tenantNamespace("bob@paytm.com")); // namespace invariant still holds
  expect(o.slug).not.toBe(squatted); // got a distinct (random-suffixed) slug
  expect(o.slug.startsWith("bob-paytm-com-")).toBe(true); // base preserved, recognizable
  expect(await orgs.roleOf(o.id, "bob@paytm.com")).toBe("owner");
  // still idempotent after the conflict path
  expect((await orgs.ensurePersonalOrg("bob@paytm.com")).id).toBe(o.id);
  await db.destroy();
});

test("createOrg (team) + members + roleOf", async () => {
  const { db, orgs } = await fix();
  const org = await orgs.createOrg("acme", "Acme", "alice@x.com");
  expect(org.kind).toBe("team");
  expect(org.namespace).toMatch(/^drop-t-org-acme-/);
  expect(await orgs.roleOf(org.id, "alice@x.com")).toBe("owner");
  await orgs.addMember(org.id, "bob@paytm.com", "member");
  expect(await orgs.roleOf(org.id, "bob@paytm.com")).toBe("member");
  expect(await orgs.roleOf(org.id, "carol@x.com")).toBeNull();
  const slugs = (await orgs.listUserOrgs("bob@paytm.com")).map((o) => o.slug);
  expect(slugs).toContain("acme");
  await orgs.removeMember(org.id, "bob@paytm.com");
  expect(await orgs.roleOf(org.id, "bob@paytm.com")).toBeNull();
  await db.destroy();
});

test("validateOrgSlug: dns-safe, reserved words rejected", () => {
  expect(validateOrgSlug("acme")).toBeNull();
  expect(validateOrgSlug("my-team-1")).toBeNull();
  expect(validateOrgSlug("Bad Slug")).not.toBeNull();
  expect(validateOrgSlug("a")).not.toBeNull();
  expect(validateOrgSlug("admin")).not.toBeNull(); // reserved
  expect(validateOrgSlug("org")).not.toBeNull();
  expect(validateOrgSlug(123)).not.toBeNull();
});
