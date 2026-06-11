import { test, expect } from "bun:test";
import { FakeBlob } from "./fake.ts";
import { PreconditionFailedError, readText } from "./types.ts";

test("put / get / deletePrefix", async () => {
  const b = new FakeBlob();
  expect(await b.get("missing")).toBeNull();

  await b.put("sites/x/v1/index.html", Buffer.from("<html>"), 6, "text/html");
  const got = (await b.get("sites/x/v1/index.html"))!;
  expect(await readText(got)).toBe("<html>");
  expect(got.contentType).toBe("text/html");

  await b.deletePrefix("sites/x/");
  expect(await b.get("sites/x/v1/index.html")).toBeNull();
});

test("ifNoneMatch enforces create-only (atomic claim)", async () => {
  const b = new FakeBlob();
  const { etag } = await b.put("sites/myapp/site.json", Buffer.from("{}"), 2, "application/json", { ifNoneMatch: true });
  expect(etag).toBeTruthy();
  // second claim must fail
  await expect(
    b.put("sites/myapp/site.json", Buffer.from("{}"), 2, "application/json", { ifNoneMatch: true }),
  ).rejects.toBeInstanceOf(PreconditionFailedError);
});

test("ifMatch enforces compare-and-swap", async () => {
  const b = new FakeBlob();
  const { etag } = await b.put("k", Buffer.from("v1"), 2, "text/plain");
  // stale etag fails
  await expect(
    b.put("k", Buffer.from("v2"), 2, "text/plain", { ifMatch: '"wrong"' }),
  ).rejects.toBeInstanceOf(PreconditionFailedError);
  // correct etag succeeds and rotates the etag
  const { etag: etag2 } = await b.put("k", Buffer.from("v2"), 2, "text/plain", { ifMatch: etag });
  expect(etag2).not.toBe(etag);
  // the old etag no longer matches
  await expect(
    b.put("k", Buffer.from("v3"), 2, "text/plain", { ifMatch: etag }),
  ).rejects.toBeInstanceOf(PreconditionFailedError);
});

test("list with delimiter returns common prefixes", async () => {
  const b = new FakeBlob();
  await b.put("sites/a/versions/v1.json", Buffer.from("{}"), 2, "application/json");
  await b.put("sites/a/versions/v2.json", Buffer.from("{}"), 2, "application/json");
  await b.put("sites/a/files/v1/index.html", Buffer.from("x"), 1, "text/html");
  const r = await b.list("sites/a/", "/");
  expect(r.prefixes).toEqual(["sites/a/files/", "sites/a/versions/"]);
});
