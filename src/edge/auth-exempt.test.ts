import { test, expect } from "bun:test";
import * as http from "node:http";
import { createEdge } from "./server.ts";
import { AuthRateLimiter, clientIpForRateLimit, isRateLimitedAuthPath, parseAuthHost } from "./auth-exempt.ts";
import { FakeBlob } from "../blob/fake.ts";
import { MetaStore } from "../metastore/store.ts";
import { PreviewStore } from "../previews/store.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { makeTestDb } from "../db/testdb.ts";

// ---- pure unit tests (no DB) ----

test("parseAuthHost: only `auth--<name>` (no nested --) yields a name", () => {
  expect(parseAuthHost("auth--shop")).toBe("shop");
  expect(parseAuthHost("shop")).toBeNull(); // not an auth host
  expect(parseAuthHost("auth--")).toBeNull(); // empty name
  expect(parseAuthHost("auth--a--b")).toBeNull(); // a real auth name can't contain -- → not an auth host
  expect(parseAuthHost("notauth--x")).toBeNull(); // wrong prefix
});

test("isRateLimitedAuthPath: only the sensitive POST paths", () => {
  expect(isRateLimitedAuthPath("POST", "/token")).toBe(true);
  expect(isRateLimitedAuthPath("POST", "/signup")).toBe(true);
  expect(isRateLimitedAuthPath("POST", "/verify")).toBe(true);
  expect(isRateLimitedAuthPath("POST", "/recover")).toBe(true);
  expect(isRateLimitedAuthPath("GET", "/token")).toBe(false); // GET is not limited
  expect(isRateLimitedAuthPath("POST", "/health")).toBe(false); // read path not limited
  expect(isRateLimitedAuthPath("POST", "/.well-known/jwks.json")).toBe(false);
});

test("AuthRateLimiter: allows `limit` then 429s, with a retry-after; refills over the window", () => {
  let t = 0;
  const rl = new AuthRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
  expect(rl.take("1.2.3.4").ok).toBe(true);
  expect(rl.take("1.2.3.4").ok).toBe(true);
  expect(rl.take("1.2.3.4").ok).toBe(true);
  const denied = rl.take("1.2.3.4");
  expect(denied.ok).toBe(false);
  expect(denied.retryAfterS).toBeGreaterThan(0);
  // a DIFFERENT ip has its own bucket
  expect(rl.take("9.9.9.9").ok).toBe(true);
  // after a full window the bucket refills
  t += 60_000;
  expect(rl.take("1.2.3.4").ok).toBe(true);
});

test("clientIpForRateLimit prefers the first x-forwarded-for hop", () => {
  expect(clientIpForRateLimit({ xff: "1.1.1.1, 2.2.2.2" })).toBe("1.1.1.1");
  expect(clientIpForRateLimit({ xRealIp: "3.3.3.3" })).toBe("3.3.3.3");
  expect(clientIpForRateLimit({})).toBe("unknown");
});

// ---- edge integration ----

async function fakeInterceptor(): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host} ${req.url}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("engine-ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())), hits };
}

async function setup(authRateLimit?: { limit: number; windowMs: number }) {
  const db = await makeTestDb();
  await new UserStore(db).upsertOnLogin("alice@example.com", null);
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  const previews = new PreviewStore(db);
  const o = await orgs.ensurePersonalOrg("alice@example.com");
  const org = { id: o.id, namespace: o.namespace };
  // (1) a genuine auth resource → the exemption target
  await meta.claimSite("shop", "alice@example.com", "auth", org);
  await meta.updateSite("shop", (s) => ({ ...s, currentVersion: "v1" }));
  // (2) a PRIVATE static site literally named "auth" with a preview labeled "beta" → its `auth--beta`
  //     host matches the prefix but is NOT an auth resource, so it must KEEP its gate.
  await meta.claimSite("auth", "alice@example.com", "site", org);
  await meta.updateSite("auth", (s) => ({ ...s, currentVersion: "vp" }));
  await meta.setVisibility("auth", "private", null);
  await previews.upsert("auth", "beta", "vp", "alice@example.com", new Date(Date.now() + 3_600_000));
  const interceptor = await fakeInterceptor();
  const edge = createEdge({ meta, blob: new FakeBlob(), baseDomain: "drop.example.com", interceptorUrl: interceptor.url, previews, ...(authRateLimit ? { authRateLimit } : {}) });
  return { edge, interceptor };
}

const req = (edge: any, host: string, path: string, method = "GET", ip = "5.5.5.5") =>
  edge.request(path, { method, headers: { host, "x-forwarded-for": ip } });

test("auth host SKIPS the platform gate and proxies to the engine (login IS the auth)", async () => {
  const { edge, interceptor } = await setup();
  const res = await req(edge, "auth--shop.drop.example.com", "/token", "POST");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("engine-ok");
  // proxied to the engine with the HOST rewritten to the registered auth-- host.
  expect(interceptor.hits.some((h) => h.includes("auth--shop.drop.example.com") && h.includes("/token"))).toBe(true);
  await interceptor.close();
});

test("a preview `auth--beta` of a PRIVATE site named \"auth\" STAYS GATED (not exempt)", async () => {
  const { edge, interceptor } = await setup();
  const res = await req(edge, "auth--beta.drop.example.com", "/anything");
  expect(res.status).toBe(403); // the platform visibility gate held — NOT proxied to any engine
  expect(interceptor.hits.length).toBe(0); // never reached the interceptor
  await interceptor.close();
});

test("rate limit: the sensitive POST path 429s after N per IP (with Retry-After)", async () => {
  const { edge, interceptor } = await setup({ limit: 2, windowMs: 60_000 });
  expect((await req(edge, "auth--shop.drop.example.com", "/token", "POST", "7.7.7.7")).status).toBe(200);
  expect((await req(edge, "auth--shop.drop.example.com", "/token", "POST", "7.7.7.7")).status).toBe(200);
  const limited = await req(edge, "auth--shop.drop.example.com", "/token", "POST", "7.7.7.7");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBeTruthy();
  // a different IP is unaffected (per-IP buckets)
  expect((await req(edge, "auth--shop.drop.example.com", "/token", "POST", "8.8.8.8")).status).toBe(200);
  // and a GET (non-sensitive) is never limited
  expect((await req(edge, "auth--shop.drop.example.com", "/settings", "GET", "7.7.7.7")).status).toBe(200);
  await interceptor.close();
});

test("a normal private site (not an auth host) still 403s — baseline gate unaffected", async () => {
  const { edge, interceptor } = await setup();
  const res = await req(edge, "auth.drop.example.com", "/"); // the private site "auth" via its own host
  expect(res.status).toBe(403);
  await interceptor.close();
});
