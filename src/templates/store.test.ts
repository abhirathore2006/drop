import { test, expect, describe } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { TemplateStore, validateTemplateSlug } from "./store.ts";
import { OrgStore } from "../orgs/store.ts";
import { UserStore } from "../users/store.ts";
import type { StackSpec } from "../stack-config.ts";
import type { TemplateVariable } from "./vars.ts";

const spec = (name: string): StackSpec => ({ name, resources: { db: { type: "database", storage: "1Gi" } } });
const vars: TemplateVariable[] = [{ key: "size", required: false, default: "1Gi" }];

async function setup() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const orgs = new OrgStore(db);
  await users.upsertOnLogin("alice@example.com", null);
  await users.upsertOnLogin("bob@example.com", null);
  const aliceOrg = await orgs.ensurePersonalOrg("alice@example.com");
  const bobOrg = await orgs.ensurePersonalOrg("bob@example.com");
  return { db, templates: new TemplateStore(db), aliceOrg, bobOrg };
}

describe("TemplateStore", () => {
  test("publish appends monotonic versions and resolve returns the latest by default", async () => {
    const { db, templates, aliceOrg } = await setup();
    const p1 = await templates.publish({ slug: "widget", orgId: aliceOrg.id, name: "Widget", visibility: "public", spec: spec("t"), variables: vars, createdBy: "alice@example.com" });
    expect(p1.version.version).toBe("1");
    const p2 = await templates.publish({ slug: "widget", orgId: aliceOrg.id, name: "Widget v2", visibility: "public", spec: spec("t"), variables: vars, createdBy: "alice@example.com" });
    expect(p2.version.version).toBe("2");
    const latest = await templates.resolve("widget");
    expect(latest!.version.version).toBe("2");
    expect(latest!.template.name).toBe("Widget v2"); // catalog card follows the latest publish
    const pinned = await templates.resolve("widget", "1");
    expect(pinned!.version.version).toBe("1");
    await db.destroy();
  });

  test("visibility: an org template is hidden from a non-member; public is instance-wide", async () => {
    const { db, templates, aliceOrg, bobOrg } = await setup();
    await templates.publish({ slug: "internal", orgId: aliceOrg.id, name: "Internal", visibility: "org", spec: spec("t"), variables: [], createdBy: "alice@example.com" });
    await templates.publish({ slug: "shared", orgId: aliceOrg.id, name: "Shared", visibility: "public", spec: spec("t"), variables: [], createdBy: "alice@example.com" });

    // Alice (member of her org) sees both.
    const aliceList = await templates.listVisible([aliceOrg.id]);
    expect(aliceList.map((t) => t.slug).sort()).toEqual(["internal", "shared"]);

    // Bob (only his own org) sees only the public one.
    const bobList = await templates.listVisible([bobOrg.id]);
    expect(bobList.map((t) => t.slug)).toEqual(["shared"]);

    // canView agrees per-template.
    const internal = (await templates.getBySlug("internal"))!;
    expect(templates.canView(internal, [aliceOrg.id])).toBe(true);
    expect(templates.canView(internal, [bobOrg.id])).toBe(false);
    await db.destroy();
  });

  test("list item carries the latest version's resource count", async () => {
    const { db, templates, aliceOrg } = await setup();
    await templates.publish({ slug: "multi", orgId: aliceOrg.id, name: "Multi", visibility: "public", spec: { name: "t", resources: { db: { type: "database" }, api: { type: "app", image: "x:1" } } }, variables: [], createdBy: "alice@example.com" });
    const list = await templates.listVisible([aliceOrg.id]);
    expect(list[0]!.resources).toBe(2);
    expect(list[0]!.latestVersion).toBe("1");
    await db.destroy();
  });
});

test("validateTemplateSlug", () => {
  expect(validateTemplateSlug("guestbook")).toBeNull();
  expect(validateTemplateSlug("ab")).not.toBeNull(); // too short
  expect(validateTemplateSlug("Bad")).not.toBeNull();
  expect(validateTemplateSlug("-x")).not.toBeNull();
});
