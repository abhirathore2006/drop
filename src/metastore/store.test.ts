import { test, expect } from "bun:test";
import { FakeBlob } from "../blob/fake.ts";
import { MetaStore } from "./store.ts";
import { SiteNotFoundError } from "./types.ts";

function store() {
  return new MetaStore(new FakeBlob());
}

test("claim is first-writer-wins", async () => {
  const m = store();
  const a = await m.claimSite("myapp", "alice@paytm.com");
  expect(a?.owner).toBe("alice@paytm.com");
  expect(a?.currentVersion).toBeNull();
  // second claimer loses
  const b = await m.claimSite("myapp", "bob@paytm.com");
  expect(b).toBeNull();
  expect((await m.getSitePlain("myapp"))!.owner).toBe("alice@paytm.com");
});

test("updateSite CAS flips the version pointer", async () => {
  const m = store();
  await m.claimSite("myapp", "alice@paytm.com");
  const updated = await m.updateSite("myapp", (s) => ({ ...s, currentVersion: "v_1" }));
  expect(updated.currentVersion).toBe("v_1");
  expect((await m.getSitePlain("myapp"))!.currentVersion).toBe("v_1");
});

test("updateSite throws when site is missing", async () => {
  const m = store();
  await expect(m.updateSite("ghost", (s) => s)).rejects.toBeInstanceOf(SiteNotFoundError);
});

test("versions are listed newest-first", async () => {
  const m = store();
  await m.claimSite("myapp", "alice@paytm.com");
  await m.putVersion("myapp", { id: "v_001", publishedBy: "a", createdAt: "t", fileCount: 1, bytes: 1 });
  await m.putVersion("myapp", { id: "v_002", publishedBy: "a", createdAt: "t", fileCount: 1, bytes: 1 });
  const vs = await m.listVersions("myapp");
  expect(vs.map((v) => v.id)).toEqual(["v_002", "v_001"]);
});

test("per-user marker index: add / list / remove", async () => {
  const m = store();
  await m.addUserSite("alice@paytm.com", "a");
  await m.addUserSite("alice@paytm.com", "b");
  await m.addUserSite("bob@paytm.com", "c");
  expect((await m.listUserSites("alice@paytm.com")).sort()).toEqual(["a", "b"]);
  expect(await m.listUserSites("bob@paytm.com")).toEqual(["c"]);
  await m.removeUserSite("alice@paytm.com", "a");
  expect(await m.listUserSites("alice@paytm.com")).toEqual(["b"]);
});

test("removing one marker doesn't clobber a name-prefix sibling", async () => {
  const m = store();
  await m.addUserSite("a@x.com", "app");
  await m.addUserSite("a@x.com", "app2");
  await m.removeUserSite("a@x.com", "app");
  expect(await m.listUserSites("a@x.com")).toEqual(["app2"]); // app2 survived
});

test("listSitesPage paginates with a cursor", async () => {
  const m = store();
  for (const n of ["s1", "s2", "s3", "s4", "s5"]) await m.claimSite(n, "o@x.com");
  const p1 = await m.listSitesPage({ limit: 2 });
  expect(p1.names.length).toBe(2);
  expect(p1.nextCursor).toBeDefined();
  const p2 = await m.listSitesPage({ limit: 2, cursor: p1.nextCursor });
  const p3 = await m.listSitesPage({ limit: 2, cursor: p2.nextCursor });
  expect(p3.names.length).toBe(1);
  expect(p3.nextCursor).toBeUndefined();
  expect([...p1.names, ...p2.names, ...p3.names].sort()).toEqual(["s1", "s2", "s3", "s4", "s5"]);
});

test("listSiteNames + deleteSite", async () => {
  const m = store();
  await m.claimSite("alpha", "a@paytm.com");
  await m.claimSite("beta", "a@paytm.com");
  expect((await m.listSiteNames()).sort()).toEqual(["alpha", "beta"]);
  await m.deleteSite("alpha");
  expect(await m.getSitePlain("alpha")).toBeNull();
  expect(await m.listSiteNames()).toEqual(["beta"]);
});
