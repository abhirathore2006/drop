import { test, expect } from "bun:test";
import { FakeBucketStore } from "./fake.ts";

test("fake provision records the call + derives the prefix", async () => {
  const s = new FakeBucketStore();
  const c = await s.provision({ name: "b1", namespace: "ns", org: "o" });
  expect(c.prefix).toBe("buckets/ns/b1/");
  expect(s.provisions).toEqual(["ns/b1"]);
});

test("fake rotate bumps the secret so a test can prove the creds changed", async () => {
  const s = new FakeBucketStore();
  const before = await s.provision({ name: "b1", namespace: "ns", org: "o" });
  const after = await s.rotate({ name: "b1", namespace: "ns", org: "o" });
  expect(after.secret).not.toBe(before.secret);
  expect(s.rotations).toEqual(["ns/b1"]);
});

test("fake usage is scriptable; destroy clears it + records", async () => {
  const s = new FakeBucketStore();
  expect(await s.usage({ name: "b1", namespace: "ns", org: "o" })).toEqual({ bytes: 0, objects: 0 });
  s.usageByKey.set("ns/b1", { bytes: 4096, objects: 3 });
  expect(await s.usage({ name: "b1", namespace: "ns", org: "o" })).toEqual({ bytes: 4096, objects: 3 });
  await s.destroy({ name: "b1", namespace: "ns", org: "o" });
  expect(s.destroyed).toEqual(["ns/b1"]);
  expect(await s.usage({ name: "b1", namespace: "ns", org: "o" })).toEqual({ bytes: 0, objects: 0 });
});
