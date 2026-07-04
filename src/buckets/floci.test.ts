import { test, expect } from "bun:test";
import { FlociBucketStore } from "./floci.ts";

const store = () =>
  new FlociBucketStore({
    bucket: "platform-bucket",
    region: "us-east-1",
    clientEndpoint: "http://localhost:4566",
    appEndpoint: "http://floci.drop-system.svc:4566",
    keyId: "test",
    secret: "test",
  });

test("floci provision derives the tenant prefix + platform creds (LOCAL)", async () => {
  const creds = await store().provision({ name: "avatars", namespace: "drop-t-alice", org: "org_alice" });
  expect(creds.prefix).toBe("buckets/drop-t-alice/avatars/");
  expect(creds.bucket).toBe("platform-bucket");
  expect(creds.endpoint).toBe("http://floci.drop-system.svc:4566"); // the IN-CLUSTER endpoint, not the host one
  expect(creds.keyId).toBe("test");
  expect(creds.secret).toBe("test");
});

test("floci provision is IDEMPOTENT (same creds every call — the deploy-binding relies on this)", async () => {
  const s = store();
  const a = await s.provision({ name: "x", namespace: "drop-t-a", org: "o" });
  const b = await s.provision({ name: "x", namespace: "drop-t-a", org: "o" });
  expect(a).toEqual(b);
  // rotate() locally returns the same static creds (documented — no per-tenant key to re-mint).
  expect(await s.rotate({ name: "x", namespace: "drop-t-a", org: "o" })).toEqual(a);
});

test("floci prefixes for two tenants never overlap (isolation via namespace)", async () => {
  const s = store();
  const a = await s.provision({ name: "shared", namespace: "drop-t-alice", org: "oa" });
  const b = await s.provision({ name: "shared", namespace: "drop-t-bob", org: "ob" });
  expect(a.prefix).not.toBe(b.prefix);
  expect(a.prefix.startsWith(b.prefix)).toBe(false);
  expect(b.prefix.startsWith(a.prefix)).toBe(false);
});

test("floci with no appEndpoint falls back to the host endpoint; no endpoint → empty (AWS default)", async () => {
  const withClientOnly = new FlociBucketStore({ bucket: "b", region: "us-east-1", clientEndpoint: "http://h:4566", keyId: "k", secret: "s" });
  expect((await withClientOnly.provision({ name: "n", namespace: "ns", org: "o" })).endpoint).toBe("http://h:4566");
  const prodLike = new FlociBucketStore({ bucket: "b", region: "us-east-1" });
  const c = await prodLike.provision({ name: "n", namespace: "ns", org: "o" });
  expect(c.endpoint).toBe(""); // prod: apps use the AWS default endpoint
  expect(c.keyId).toBe(""); // prod credentials require the (deferred) aws-iam store
});
