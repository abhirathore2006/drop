import { test, expect } from "bun:test";
import { createEdge } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
import { MetaStore } from "../metastore/store.ts";

async function setup() {
  const blob = new FakeBlob();
  const meta = new MetaStore(blob);
  await meta.claimSite("myapp", "alice@paytm.com");
  const prefix = meta.filesPrefix("myapp", "v1");
  await blob.put(prefix + "index.html", Buffer.from("<html>app</html>"), 16, "text/html");
  await blob.put(prefix + "assets/app.js", Buffer.from("console.log(1)"), 14, "application/javascript");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1" }));
  return createEdge({ meta, blob, baseDomain: "drop.company.com" });
}

const get = (app: any, host: string, path: string, accept = "") =>
  app.request(path, { headers: { host, ...(accept ? { accept } : {}) } });

test("serves index at root", async () => {
  const res = await get(await setup(), "myapp.drop.company.com", "/", "text/html");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<html>app</html>");
});

test("serves a static asset", async () => {
  const res = await get(await setup(), "myapp.drop.company.com", "/assets/app.js");
  expect(res.status).toBe(200);
});

test("navigation route falls back to index", async () => {
  const res = await get(await setup(), "myapp.drop.company.com", "/dashboard/settings", "text/html");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<html>app</html>");
});

test("missing asset returns 404, NOT html", async () => {
  const res = await get(await setup(), "myapp.drop.company.com", "/assets/missing.js");
  expect(res.status).toBe(404);
  expect(await res.text()).not.toBe("<html>app</html>");
});

test("unknown site -> 404", async () => {
  const res = await get(await setup(), "nope.drop.company.com", "/", "text/html");
  expect(res.status).toBe(404);
});

test("disk cache: second request (even a fresh instance) skips S3", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "drop-edge-cache-"));

  const blob = new FakeBlob();
  const meta = new MetaStore(blob);
  await meta.claimSite("myapp", "alice@paytm.com");
  const prefix = meta.filesPrefix("myapp", "v1");
  await blob.put(prefix + "app.js", Buffer.from("console.log(1)"), 14, "application/javascript");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1" }));

  let fileGets = 0;
  const orig = blob.get.bind(blob);
  blob.get = (k: string) => {
    if (k.includes("/files/")) fileGets++;
    return orig(k);
  };

  const hit = (app: any) => app.request("/app.js", { headers: { host: "myapp.drop.company.com" } });
  const a = createEdge({ meta, blob, baseDomain: "drop.company.com", diskCacheDir: dir });
  expect((await hit(a)).status).toBe(200); // S3 → disk
  await Bun.sleep(20); // let the async disk write settle
  // a brand-new edge instance (simulates restart / another replica on same volume)
  const b = createEdge({ meta, blob, baseDomain: "drop.company.com", diskCacheDir: dir });
  const r = await hit(b);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("console.log(1)");
  expect(fileGets).toBe(1); // served from disk the 2nd time — no extra S3 read
});
