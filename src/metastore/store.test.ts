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

test("listSiteNames + deleteSite", async () => {
  const m = store();
  await m.claimSite("alpha", "a@paytm.com");
  await m.claimSite("beta", "a@paytm.com");
  expect((await m.listSiteNames()).sort()).toEqual(["alpha", "beta"]);
  await m.deleteSite("alpha");
  expect(await m.getSitePlain("alpha")).toBeNull();
  expect(await m.listSiteNames()).toEqual(["beta"]);
});
