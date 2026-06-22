import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "./store.ts";
import { SiteNotFoundError } from "./types.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  for (const e of ["alice@x.com", "bob@x.com", "carol@x.com"]) await users.upsertOnLogin(e, null);
  return { db, meta: new MetaStore(db), orgs: new OrgStore(db) };
}

// claim a resource into the owner's personal org (the FK chain needs the org to exist first).
async function claim(t: { meta: MetaStore; orgs: OrgStore }, name: string, owner: string, type: "site" | "app" | "database" = "site") {
  const o = await t.orgs.ensurePersonalOrg(owner);
  return t.meta.claimSite(name, owner, type, { id: o.id, namespace: o.namespace });
}

test("claim is first-writer-wins and sets owner membership + defaults", async () => {
  const { db, meta, orgs } = await fix();
  const a = await claim({ meta, orgs }, "app", "alice@x.com");
  expect(a?.owner).toBe("alice@x.com");
  expect(a?.currentVersion).toBeNull();
  expect(a?.visibility).toBe("public");
  expect(a?.members).toEqual([{ email: "alice@x.com", role: "owner" }]);
  expect(await claim({ meta, orgs }, "app", "bob@x.com")).toBeNull();
  expect((await meta.getSitePlain("app"))!.owner).toBe("alice@x.com");
  await db.destroy();
});

test("updateSite flips pointer + denormalizes config under a row lock", async () => {
  const { db, meta, orgs } = await fix();
  await claim({ meta, orgs }, "app", "alice@x.com");
  const up = await meta.updateSite("app", (s) => ({ ...s, currentVersion: "v_1", config: { name: "app" } }));
  expect(up.currentVersion).toBe("v_1");
  const p = (await meta.getPointer("app"))!;
  expect(p.currentVersion).toBe("v_1");
  expect(p.config).toEqual({ name: "app" });
  await db.destroy();
});

test("updateSite throws on missing site", async () => {
  const { db, meta, orgs } = await fix();
  await expect(meta.updateSite("ghost", (s) => s)).rejects.toBeInstanceOf(SiteNotFoundError);
  await db.destroy();
});

test("versions listed newest-first", async () => {
  const { db, meta, orgs } = await fix();
  await claim({ meta, orgs }, "app", "alice@x.com");
  await meta.putVersion("app", { id: "v_001", publishedBy: "alice@x.com", createdAt: "2026-01-01T00:00:00.000Z", fileCount: 1, bytes: 10 });
  await meta.putVersion("app", { id: "v_002", publishedBy: "alice@x.com", createdAt: "2026-01-02T00:00:00.000Z", fileCount: 2, bytes: 20 });
  const vs = await meta.listVersions("app");
  expect(vs.map((v) => v.id)).toEqual(["v_002", "v_001"]);
  expect(vs[0].bytes).toBe(20);
  expect(vs[0].fileCount).toBe(2);
  await db.destroy();
});

test("members: add/remove + listUserSites includes owned & shared", async () => {
  const { db, meta, orgs } = await fix();
  await claim({ meta, orgs }, "app", "alice@x.com");
  await meta.addMember("app", "bob@x.com", "editor");
  expect((await meta.getSitePlain("app"))!.collaborators).toEqual(["bob@x.com"]);
  expect((await meta.listUserSites("alice@x.com")).sort()).toEqual(["app"]);
  expect((await meta.listUserSites("bob@x.com")).sort()).toEqual(["app"]);
  await meta.removeMember("app", "bob@x.com");
  expect(await meta.listUserSites("bob@x.com")).toEqual([]);
  await db.destroy();
});

test("removeMember never removes the owner", async () => {
  const { db, meta, orgs } = await fix();
  await claim({ meta, orgs }, "app", "alice@x.com");
  await meta.removeMember("app", "alice@x.com"); // no-op: owner protected
  expect((await meta.getSitePlain("app"))!.owner).toBe("alice@x.com");
  await db.destroy();
});

test("transferOwner demotes old owner to editor, promotes new", async () => {
  const { db, meta, orgs } = await fix();
  await claim({ meta, orgs }, "app", "alice@x.com");
  await meta.transferOwner("app", "carol@x.com");
  const s = (await meta.getSitePlain("app"))!;
  expect(s.owner).toBe("carol@x.com");
  expect(s.collaborators).toContain("alice@x.com");
  await db.destroy();
});

test("setVisibility password sets hash; reflected in pointer", async () => {
  const { db, meta, orgs } = await fix();
  await claim({ meta, orgs }, "app", "alice@x.com");
  await meta.setVisibility("app", "password", "sha256:abc");
  let p = (await meta.getPointer("app"))!;
  expect(p.visibility).toBe("password");
  expect(p.passwordHash).toBe("sha256:abc");
  await meta.setVisibility("app", "public", null);
  p = (await meta.getPointer("app"))!;
  expect(p.visibility).toBe("public");
  expect(p.passwordHash).toBeNull();
  await db.destroy();
});

test("setVisibility throws on missing site", async () => {
  const { db, meta, orgs } = await fix();
  await expect(meta.setVisibility("ghost", "private", null)).rejects.toBeInstanceOf(SiteNotFoundError);
  await db.destroy();
});

test("listSitesPage keyset paginates + name prefix", async () => {
  const { db, meta, orgs } = await fix();
  for (const n of ["s1", "s2", "s3"]) await claim({ meta, orgs }, n, "alice@x.com");
  const p1 = await meta.listSitesPage({ limit: 2 });
  expect(p1.names).toEqual(["s1", "s2"]);
  expect(p1.nextCursor).toBe("s2");
  const p2 = await meta.listSitesPage({ limit: 2, cursor: p1.nextCursor });
  expect(p2.names).toEqual(["s3"]);
  expect(p2.nextCursor).toBeUndefined();
  expect((await meta.listSitesPage({ prefix: "s1" })).names).toEqual(["s1"]);
  await db.destroy();
});

test("deleteSite cascades members + versions", async () => {
  const { db, meta, orgs } = await fix();
  await claim({ meta, orgs }, "app", "alice@x.com");
  await meta.addMember("app", "bob@x.com", "viewer");
  await meta.putVersion("app", { id: "v_1", publishedBy: "alice@x.com", createdAt: "2026-01-01T00:00:00.000Z", fileCount: 1, bytes: 1 });
  await meta.deleteSite("app");
  expect(await meta.getSitePlain("app")).toBeNull();
  expect(await meta.listUserSites("bob@x.com")).toEqual([]);
  expect(await meta.listVersions("app")).toEqual([]);
  await db.destroy();
});
