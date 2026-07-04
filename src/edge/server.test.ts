import { test, expect } from "bun:test";
import * as http from "node:http";
import { createEdge, parsePreviewHost } from "./server.ts";
import { FakeBlob } from "../blob/fake.ts";
import { MetaStore } from "../metastore/store.ts";
import { PreviewStore } from "../previews/store.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { makeTestDb } from "../db/testdb.ts";

/** A throwaway local HTTP server standing in for the in-cluster KEDA interceptor. */
async function fakeInterceptor(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** db + meta + blob with the owner user seeded (FK for claim). */
async function base() {
  const db = await makeTestDb();
  await new UserStore(db).upsertOnLogin("alice@example.com", null);
  return { db, meta: new MetaStore(db), blob: new FakeBlob(), orgs: new OrgStore(db) };
}

// claim into the owner's personal org (the FK chain needs the org to exist first).
async function claim(meta: MetaStore, orgs: OrgStore, name: string, owner: string, type: "site" | "app" | "database" = "site") {
  const o = await orgs.ensurePersonalOrg(owner);
  return meta.claimSite(name, owner, type, { id: o.id, namespace: o.namespace });
}

async function setup() {
  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "myapp", "alice@example.com");
  const prefix = meta.filesPrefix("myapp", "v1");
  await blob.put(prefix + "index.html", Buffer.from("<html>app</html>"), 16, "text/html");
  await blob.put(prefix + "assets/app.js", Buffer.from("console.log(1)"), 14, "application/javascript");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1" }));
  return createEdge({ meta, blob, baseDomain: "drop.example.com" });
}

const get = (app: any, host: string, path: string, accept = "") =>
  app.request(path, { headers: { host, ...(accept ? { accept } : {}) } });

test("serves index at root", async () => {
  const res = await get(await setup(), "myapp.drop.example.com", "/", "text/html");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<html>app</html>");
});

test("serves a static asset", async () => {
  const res = await get(await setup(), "myapp.drop.example.com", "/assets/app.js");
  expect(res.status).toBe(200);
});

test("routes by x-forwarded-host when behind a proxy (nginx/ALB)", async () => {
  const app = await setup();
  // The direct Host is the proxy's own host; the real site is in x-forwarded-host.
  const res = await app.request("/", {
    headers: { host: "localhost:8474", "x-forwarded-host": "myapp.drop.example.com", accept: "text/html" },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<html>app</html>");
});

test("navigation route falls back to index", async () => {
  const res = await get(await setup(), "myapp.drop.example.com", "/dashboard/settings", "text/html");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<html>app</html>");
});

test("missing asset returns 404, NOT html", async () => {
  const res = await get(await setup(), "myapp.drop.example.com", "/assets/missing.js");
  expect(res.status).toBe(404);
  expect(await res.text()).not.toBe("<html>app</html>");
});

test("unknown site -> 404", async () => {
  const res = await get(await setup(), "nope.drop.example.com", "/", "text/html");
  expect(res.status).toBe(404);
});

async function setupCfg(config: any) {
  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "myapp", "alice@example.com");
  const p = meta.filesPrefix("myapp", "v1");
  await blob.put(p + "index.html", Buffer.from("<html>app</html>"), 16, "text/html");
  await blob.put(p + "app.html", Buffer.from("<html>spa</html>"), 16, "text/html");
  await blob.put(p + "404.html", Buffer.from("<html>nope</html>"), 17, "text/html");
  await blob.put(p + "assets/app.js", Buffer.from("x"), 1, "application/javascript");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1", config }));
  return createEdge({ meta, blob, baseDomain: "drop.example.com" });
}
const creq = (app: any, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { host: "myapp.drop.example.com", ...headers } });

test("config: basic auth gates the site", async () => {
  const app = await setupCfg({ basicAuth: { users: { u: "p" } } });
  const no = await creq(app, "/");
  expect(no.status).toBe(401);
  expect(no.headers.get("www-authenticate")).toContain("Basic");
  const tok = "Basic " + Buffer.from("u:p").toString("base64");
  expect((await creq(app, "/", { authorization: tok })).status).toBe(200);
});

test("visibility: private fails closed with 403", async () => {
  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "myapp", "alice@example.com");
  const p = meta.filesPrefix("myapp", "v1");
  await blob.put(p + "index.html", Buffer.from("<html>secret</html>"), 19, "text/html");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1" }));
  await meta.setVisibility("myapp", "private", null);
  const app = createEdge({ meta, blob, baseDomain: "drop.example.com" });
  const r = await creq(app, "/");
  expect(r.status).toBe(403);
  expect(await r.text()).not.toContain("secret");
});

test("visibility: password (API-set hash) requires basic auth", async () => {
  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "myapp", "alice@example.com");
  const p = meta.filesPrefix("myapp", "v1");
  await blob.put(p + "index.html", Buffer.from("<html>app</html>"), 16, "text/html");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1" }));
  const { hashPassword } = await import("../site-config.ts");
  await meta.setVisibility("myapp", "password", hashPassword("opensesame"));
  const app = createEdge({ meta, blob, baseDomain: "drop.example.com" });

  expect((await creq(app, "/")).status).toBe(401);
  const tok = "Basic " + Buffer.from("anyuser:opensesame").toString("base64");
  expect((await creq(app, "/", { authorization: tok })).status).toBe(200);
  const bad = "Basic " + Buffer.from("anyuser:wrong").toString("base64");
  expect((await creq(app, "/", { authorization: bad })).status).toBe(401);
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

// ---- Phase B: type=app dispatch → reverse-proxy to the KEDA interceptor ----

test("type=app reverse-proxies to the interceptor with the reconstructed Host; path+query preserved", async () => {
  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "billing", "alice@example.com", "app");
  await meta.updateSite("billing", (s) => ({ ...s, currentVersion: "v1" }));
  const seen: { host?: string; path?: string; method?: string } = {};
  const icept = await fakeInterceptor((req, res) => {
    seen.host = req.headers.host;
    seen.path = req.url;
    seen.method = req.method;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello-from-app");
  });
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com", interceptorUrl: icept.url });
  const res = await edge.request("/dashboard/x?q=1", { headers: { host: "billing.drop.example.com" } });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello-from-app");
  expect(seen.host).toBe("billing.drop.example.com"); // KEDA routes (and wakes) by the registered HSO host
  expect(seen.path).toBe("/dashboard/x?q=1"); // path + query preserved
  expect(seen.method).toBe("GET");
  await icept.close();
});

test("type=app forwards the request body + method (POST)", async () => {
  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "ingest", "alice@example.com", "app");
  await meta.updateSite("ingest", (s) => ({ ...s, currentVersion: "v1" }));
  const icept = await fakeInterceptor((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(201);
      res.end(`${req.method}:${body}`);
    });
  });
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com", interceptorUrl: icept.url });
  const res = await edge.request("/api", { method: "POST", headers: { host: "ingest.drop.example.com" }, body: "ping" });
  expect(res.status).toBe(201);
  expect(await res.text()).toBe("POST:ping");
  await icept.close();
});

// NOTE: the client-abort-mid-upload crash (a missing 'error' listener on the piped
// request-body source → uncaughtException → whole-replica DoS) is guarded by the
// rs.on("error") handler in proxyToApp. It isn't unit-tested here: faithfully
// reproducing it needs a real node http server + a raw socket that RSTs mid-body
// (bun's in-memory app.request rejects on the CLIENT side instead, testing the wrong
// layer). The fix is reasoned + review-validated.

test("type=app returns 503 when the interceptor is not configured", async () => {
  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "noroute", "alice@example.com", "app");
  await meta.updateSite("noroute", (s) => ({ ...s, currentVersion: "v1" }));
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com" }); // no interceptorUrl
  const res = await edge.request("/", { headers: { host: "noroute.drop.example.com" } });
  expect(res.status).toBe(503);
});

test("type=app not yet deployed (no current version) → 404", async () => {
  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "pending", "alice@example.com", "app"); // claimed, never deployed
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com", interceptorUrl: "http://127.0.0.1:9" });
  const res = await edge.request("/", { headers: { host: "pending.drop.example.com" } });
  expect(res.status).toBe(404);
});

test("disk cache: second request (even a fresh instance) skips S3", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "drop-edge-cache-"));

  const { meta, blob, orgs } = await base();
  await claim(meta, orgs, "myapp", "alice@example.com");
  const prefix = meta.filesPrefix("myapp", "v1");
  await blob.put(prefix + "app.js", Buffer.from("console.log(1)"), 14, "application/javascript");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1" }));

  let fileGets = 0;
  const orig = blob.get.bind(blob);
  blob.get = (k: string) => {
    if (k.includes("/files/")) fileGets++;
    return orig(k);
  };

  const hit = (app: any) => app.request("/app.js", { headers: { host: "myapp.drop.example.com" } });
  const a = createEdge({ meta, blob, baseDomain: "drop.example.com", diskCacheDir: dir });
  expect((await hit(a)).status).toBe(200); // S3 → disk
  await Bun.sleep(150); // let the async disk write settle
  // a brand-new edge instance (simulates restart / another replica on same volume)
  const b = createEdge({ meta, blob, baseDomain: "drop.example.com", diskCacheDir: dir });
  const r = await hit(b);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("console.log(1)");
  expect(fileGets).toBe(1); // served from disk the 2nd time — no extra S3 read
});

// ---- previews (E1) ------------------------------------------------------------------------------

/** myapp: current_version=v1 ("current"), plus a "pr1" preview pointing at v2 ("preview"). */
async function setupPreview(expiresAt = new Date(Date.now() + 60_000)) {
  const { db, meta, blob, orgs } = await base();
  await claim(meta, orgs, "myapp", "alice@example.com");
  const p1 = meta.filesPrefix("myapp", "v1");
  await blob.put(p1 + "index.html", Buffer.from("current"), 7, "text/html");
  const p2 = meta.filesPrefix("myapp", "v2");
  await blob.put(p2 + "index.html", Buffer.from("preview"), 7, "text/html");
  await meta.updateSite("myapp", (s) => ({ ...s, currentVersion: "v1" }));
  const previews = new PreviewStore(db);
  await previews.upsert("myapp", "pr1", "v2", "alice@example.com", expiresAt);
  return { db, meta, blob, previews };
}

test("parsePreviewHost splits <site>--<label>; null for a plain host or a malformed split", () => {
  expect(parsePreviewHost("myapp--pr1")).toEqual({ site: "myapp", label: "pr1" });
  expect(parsePreviewHost("myapp")).toBeNull();
  expect(parsePreviewHost("--pr1")).toBeNull(); // empty site half
  expect(parsePreviewHost("myapp--")).toBeNull(); // empty label half
});

test("preview host serves the PREVIEW version's bytes; the main host still serves current", async () => {
  const { meta, blob, previews } = await setupPreview();
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com", previews });
  const main = await edge.request("/", { headers: { host: "myapp.drop.example.com", accept: "text/html" } });
  expect(main.status).toBe(200);
  expect(await main.text()).toBe("current");
  const pv = await edge.request("/", { headers: { host: "myapp--pr1.drop.example.com", accept: "text/html" } });
  expect(pv.status).toBe(200);
  expect(await pv.text()).toBe("preview");
});

test("unknown preview label -> 404 (not the parent's current bytes)", async () => {
  const { meta, blob, previews } = await setupPreview();
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com", previews });
  const res = await edge.request("/", { headers: { host: "myapp--nope.drop.example.com", accept: "text/html" } });
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("current");
});

test("expired preview -> 404", async () => {
  const { meta, blob, previews } = await setupPreview(new Date(Date.now() - 1000)); // already expired
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com", previews });
  const res = await edge.request("/", { headers: { host: "myapp--pr1.drop.example.com", accept: "text/html" } });
  expect(res.status).toBe(404);
});

test("previews store not configured -> preview host 404s gracefully (no crash)", async () => {
  const { meta, blob } = await setupPreview();
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com" }); // no `previews`
  const res = await edge.request("/", { headers: { host: "myapp--pr1.drop.example.com", accept: "text/html" } });
  expect(res.status).toBe(404);
});

test("X-Robots-Tag: noindex is present on EVERY preview response (200 and 404); absent on the main host", async () => {
  const { meta, blob, previews } = await setupPreview();
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com", previews });
  const ok = await edge.request("/", { headers: { host: "myapp--pr1.drop.example.com", accept: "text/html" } });
  expect(ok.headers.get("x-robots-tag")).toBe("noindex");
  const missing = await edge.request("/", { headers: { host: "myapp--nope.drop.example.com", accept: "text/html" } });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("x-robots-tag")).toBe("noindex");
  const main = await edge.request("/", { headers: { host: "myapp.drop.example.com", accept: "text/html" } });
  expect(main.headers.get("x-robots-tag")).toBeNull();
});

test("preview inherits the PARENT site's visibility/password gate (never its own)", async () => {
  const { meta, blob, previews } = await setupPreview();
  const { hashPassword } = await import("../site-config.ts");
  await meta.setVisibility("myapp", "password", hashPassword("opensesame"));
  const edge = createEdge({ meta, blob, baseDomain: "drop.example.com", previews });
  const no = await edge.request("/", { headers: { host: "myapp--pr1.drop.example.com" } });
  expect(no.status).toBe(401);
  const tok = "Basic " + Buffer.from("anyuser:opensesame").toString("base64");
  const ok = await edge.request("/", { headers: { host: "myapp--pr1.drop.example.com", authorization: tok } });
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("preview");
});
