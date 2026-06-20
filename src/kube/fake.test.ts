import { test, expect } from "bun:test";
import { FakeKube } from "./fake.ts";
import { appManifests } from "./manifests.ts";

test("FakeKube records applies, serves getApp, and deletes", async () => {
  const k = new FakeKube();
  const m = appManifests({ image: "x:1", services: [{ internalPort: 8080, protocol: "http" }] }, {
    name: "billing",
    namespace: "drop-acme",
    host: "billing.drop.example.com",
  });

  expect(await k.getApp("drop-acme", "billing")).toBeNull();
  await k.applyApp("drop-acme", "billing", m);
  expect(k.applies).toHaveLength(1);
  expect(await k.getApp("drop-acme", "billing")).toBe(m);

  await k.deleteApp("drop-acme", "billing");
  expect(await k.getApp("drop-acme", "billing")).toBeNull();
  expect(k.deletes).toEqual([{ namespace: "drop-acme", name: "billing" }]);
});
