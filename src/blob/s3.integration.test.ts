import { test, expect } from "bun:test";
import { S3Blob } from "./s3.ts";
import { PreconditionFailedError, readText } from "./types.ts";
import { MetaStore } from "../metastore/store.ts";

const endpoint = process.env.DROP_TEST_S3_ENDPOINT;
const opts = {
  bucket: process.env.DROP_TEST_S3_BUCKET ?? "drop-itest",
  endpoint: endpoint!,
  region: "us-east-1",
  keyId: process.env.DROP_TEST_S3_KEY_ID ?? "test",
  secret: process.env.DROP_TEST_S3_SECRET ?? "test",
};

// A unique prefix per run avoids cross-run collisions on a shared bucket.
const RUN = `itest-${Date.now()}`;

test.skipIf(!endpoint)("ensureBucket + put/get/list/delete round trip", async () => {
  const b = new S3Blob(opts);
  await b.ensureBucket();
  await b.put(`${RUN}/v1/a.txt`, Buffer.from("hello"), 5, "text/plain");
  const got = (await b.get(`${RUN}/v1/a.txt`))!;
  expect(await readText(got)).toBe("hello");
  expect(got.contentType).toBe("text/plain");

  await b.put(`${RUN}/v1/b.txt`, Buffer.from("x"), 1, "text/plain");
  const list = await b.list(`${RUN}/v1/`);
  expect(list.keys.sort()).toEqual([`${RUN}/v1/a.txt`, `${RUN}/v1/b.txt`]);

  await b.deletePrefix(`${RUN}/v1/`);
  expect(await b.get(`${RUN}/v1/a.txt`)).toBeNull();
});

test.skipIf(!endpoint)("conditional writes: If-None-Match claim is first-wins on Floci", async () => {
  const b = new S3Blob(opts);
  await b.ensureBucket();
  const key = `${RUN}/claim/site.json`;
  await b.put(key, Buffer.from("{}"), 2, "application/json", { ifNoneMatch: true });
  // second create MUST fail — this proves Floci honors If-None-Match
  await expect(
    b.put(key, Buffer.from("{}"), 2, "application/json", { ifNoneMatch: true }),
  ).rejects.toBeInstanceOf(PreconditionFailedError);
  await b.deletePrefix(`${RUN}/claim/`);
});

test.skipIf(!endpoint)("MetaStore claim + CAS against real S3", async () => {
  const b = new S3Blob(opts);
  await b.ensureBucket();
  const name = `${RUN}-site`;
  const m = new MetaStore(b);
  const claimed = await m.claimSite(name, "alice@paytm.com");
  expect(claimed?.owner).toBe("alice@paytm.com");
  // second claim loses (relies on If-None-Match support)
  const second = await m.claimSite(name, "bob@paytm.com");
  expect(second).toBeNull();
  // CAS update flips the pointer
  const updated = await m.updateSite(name, (s) => ({ ...s, currentVersion: "v_1" }));
  expect(updated.currentVersion).toBe("v_1");
  await m.deleteSite(name);
});
