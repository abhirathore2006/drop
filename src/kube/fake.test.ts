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

test("FakeKube records applyTenant", async () => {
  const { FakeKube } = await import("./fake.ts");
  const { tenantManifests } = await import("./manifests.ts");
  const k = new FakeKube();
  await k.applyTenant("drop-t-x", tenantManifests("drop-t-x"));
  expect(k.tenantApplies).toHaveLength(1);
  expect(k.tenantApplies[0]!.namespace).toBe("drop-t-x");
});

// ---- G1: scriptable follow-log stream ----

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream as any) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

test("getWorkloadLogsStream: unscripted namespace/name -> null", async () => {
  const k = new FakeKube();
  expect(await k.getWorkloadLogsStream("ns", "nope")).toBeNull();
});

test("getWorkloadLogsStream: emits the scripted lines then ends", async () => {
  const k = new FakeKube();
  k.scriptedLogStreams.set("ns/billing", { lines: ["one", "two", "three"] });
  const stream = await k.getWorkloadLogsStream("ns", "billing");
  expect(stream).not.toBeNull();
  expect(await drain(stream!)).toBe("one\ntwo\nthree\n");
});

test("getWorkloadLogsStream: aborting the signal destroys a keepOpen stream and records the abort", async () => {
  const k = new FakeKube();
  k.scriptedLogStreams.set("ns/billing", { lines: ["one"], keepOpen: true });
  const controller = new AbortController();
  const stream = await k.getWorkloadLogsStream("ns", "billing", { signal: controller.signal });
  expect(stream!.destroyed).toBe(false);
  controller.abort();
  expect(k.logStreamAborts).toEqual([{ namespace: "ns", name: "billing" }]);
  expect(stream!.destroyed).toBe(true);
});
