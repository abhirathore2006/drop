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

async function setupCfg(config: any) {
  const blob = new FakeBlob();
  const meta = new MetaStore(blob);
  await meta.claimSite("myapp", "alice@paytm.com");
  const p = meta.filesPrefix("myapp", "v1");
  await blob.put(p + "index.html", Buffer.from("<html>app</html>"), 16, "text/html");
  await blob.put(p + "app.html", Buffer.from("<html>spa</html>"), 16, "text/html");
  await blob.put(p + "404.html", Buffer.from("<html>nope</html>"), 17, "text/html");
  await blob.put(p + "assets/app.js", Buffer.from("x"), 1, "application/javascript");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1", config }));
  return createEdge({ meta, blob, baseDomain: "drop.company.com" });
}
const creq = (app: any, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { host: "myapp.drop.company.com", ...headers } });

test("config: basic auth gates the site", async () => {
  const app = await setupCfg({ basicAuth: { users: { u: "p" } } });
  const no = await creq(app, "/");
  expect(no.status).toBe(401);
  expect(no.headers.get("www-authenticate")).toContain("Basic");
  const tok = "Basic " + Buffer.from("u:p").toString("base64");
  expect((await creq(app, "/", { authorization: tok })).status).toBe(200);
});

test("config: redirect", async () => {
  const app = await setupCfg({ redirects: [{ from: "/old", to: "/new", status: 301 }] });
  const r = await creq(app, "/old");
  expect(r.status).toBe(301);
  expect(r.headers.get("location")).toBe("/new");
});

test("config: custom spaFallback + disable", async () => {
  const a = await setupCfg({ spaFallback: "app.html" });
  expect(await (await creq(a, "/deep", { accept: "text/html" })).text()).toBe("<html>spa</html>");
  const b = await setupCfg({ spaFallback: false });
  expect((await creq(b, "/deep", { accept: "text/html" })).status).toBe(404);
});

test("config: header override (cache-control) + CORS", async () => {
  const app = await setupCfg({
    headers: [{ source: "/assets/*", headers: { "cache-control": "public, max-age=31536000, immutable" } }],
    cors: true,
  });
  const r = await creq(app, "/assets/app.js", { origin: "https://x.com" });
  expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
});

test("config: custom 404 document", async () => {
  const app = await setupCfg({ notFound: "404.html" });
  const r = await creq(app, "/assets/missing.js");
  expect(r.status).toBe(404);
  expect(await r.text()).toBe("<html>nope</html>");
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
  await Bun.sleep(150); // let the async disk write settle
  // a brand-new edge instance (simulates restart / another replica on same volume)
  const b = createEdge({ meta, blob, baseDomain: "drop.company.com", diskCacheDir: dir });
  const r = await hit(b);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("console.log(1)");
  expect(fileGets).toBe(1); // served from disk the 2nd time — no extra S3 read
});
