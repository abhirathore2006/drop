import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { parseSiteConfig, matchRedirect, headersForPath, basicAuthOk, corsHeaders } from "./site-config.ts";

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

test("parse keeps known fields, drops junk", () => {
  const c = parseSiteConfig(
    JSON.stringify({
      spaFallback: "app.html",
      cleanUrls: true,
      redirects: [{ from: "/old", to: "/new", status: 302 }, { bad: true }],
      headers: [{ source: "/assets/*", headers: { "Cache-Control": "public, max-age=31536000", x: 1 } }],
      cors: { allowOrigins: ["https://x.com"], credentials: true },
      basicAuth: { realm: "R", users: { alice: "pw" } },
      nonsense: 123,
    }),
  );
  expect(c.spaFallback).toBe("app.html");
  expect(c.cleanUrls).toBe(true);
  expect(c.redirects).toEqual([{ from: "/old", to: "/new", status: 302 }]);
  expect(c.headers![0].headers["cache-control"]).toBe("public, max-age=31536000");
  expect(c.headers![0].headers.x).toBeUndefined(); // non-string dropped
  expect((c.cors as any).credentials).toBe(true);
  expect(c.basicAuth!.users.alice).toBe("pw");
  expect((c as any).nonsense).toBeUndefined();
});

test("spaFallback:false disables", () => {
  expect(parseSiteConfig('{"spaFallback":false}').spaFallback).toBe(false);
});

test("invalid JSON throws", () => {
  expect(() => parseSiteConfig("{not json")).toThrow();
});

test("matchRedirect: exact, glob splat, default status", () => {
  const r = [{ from: "/old", to: "/new" }, { from: "/docs/*", to: "/help/:splat", status: 302 }];
  expect(matchRedirect("/old", r)).toEqual({ to: "/new", status: 301 });
  expect(matchRedirect("/docs/a/b", r)).toEqual({ to: "/help/a/b", status: 302 });
  expect(matchRedirect("/nope", r)).toBeNull();
});

test("headersForPath merges matching globs", () => {
  const rules: { source: string; headers: Record<string, string> }[] = [
    { source: "/assets/*", headers: { "cache-control": "immutable" } },
    { source: "/*", headers: { "x-frame-options": "DENY" } },
  ];
  expect(headersForPath("/assets/app.js", rules)).toEqual({ "cache-control": "immutable", "x-frame-options": "DENY" });
  expect(headersForPath("/index.html", rules)).toEqual({ "x-frame-options": "DENY" });
});

test("basicAuthOk: plaintext + sha256", () => {
  const users = { alice: "secret", bob: sha("secret") };
  const hdr = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
  expect(basicAuthOk(hdr("alice", "secret"), users)).toBe(true);
  expect(basicAuthOk(hdr("alice", "wrong"), users)).toBe(false);
  expect(basicAuthOk(hdr("bob", "secret"), users)).toBe(true);
  expect(basicAuthOk(hdr("ghost", "x"), users)).toBe(false);
  expect(basicAuthOk(undefined, users)).toBe(false);
});

test("corsHeaders: wildcard and explicit origin", () => {
  expect(corsHeaders("https://a.com", true)["access-control-allow-origin"]).toBe("*");
  const c = corsHeaders("https://a.com", { allowOrigins: ["https://a.com"], credentials: true });
  expect(c["access-control-allow-origin"]).toBe("https://a.com");
  expect(c["access-control-allow-credentials"]).toBe("true");
  expect(corsHeaders("https://evil.com", { allowOrigins: ["https://a.com"] })).toEqual({});
});

import {
  sanitizeSiteConfig,
  parseDropYaml,
  loadSiteConfig,
  CONFIG_FILE_YAML,
  CONFIG_FILE_JSON,
} from "./site-config.ts";

test("sanitizeSiteConfig sanitizes a raw object like parseSiteConfig does its JSON", () => {
  const raw = { spaFallback: "app.html", redirects: [{ from: "/old", to: "/new" }], bogus: 123 };
  expect(sanitizeSiteConfig(raw)).toEqual(parseSiteConfig(JSON.stringify(raw)));
  expect(sanitizeSiteConfig(raw).spaFallback).toBe("app.html");
});

test("sanitizeSiteConfig tolerates null/undefined/non-objects", () => {
  expect(sanitizeSiteConfig(undefined)).toEqual({});
  expect(sanitizeSiteConfig(null)).toEqual({});
  expect(sanitizeSiteConfig("nope")).toEqual({});
});

test("parseDropYaml reads the site: section into a SiteConfig", () => {
  const cfg = parseDropYaml(
    'site:\n  spaFallback: false\n  headers:\n    - source: "/*"\n      headers:\n        x-frame-options: SAMEORIGIN\n',
  );
  expect(cfg.spaFallback).toBe(false);
  expect(cfg.headers).toEqual([{ source: "/*", headers: { "x-frame-options": "SAMEORIGIN" } }]);
});

test("parseDropYaml ignores future app:/database: sections and a missing site:", () => {
  expect(parseDropYaml("app:\n  name: billing\n  image: x\n")).toEqual({});
  expect(parseDropYaml("")).toEqual({});
});

test("parseDropYaml throws on malformed YAML", () => {
  expect(() => parseDropYaml("site:\n  - : : :\n   bad")).toThrow();
});

test("loadSiteConfig prefers drop.yaml over _drop.json", () => {
  const r = loadSiteConfig({ yaml: "site:\n  name: fromyaml\n", json: '{"name":"fromjson"}' });
  expect(r).toEqual({ config: { name: "fromyaml" }, source: "drop.yaml" });
});

test("loadSiteConfig falls back to _drop.json, and returns undefined for neither", () => {
  expect(loadSiteConfig({ json: '{"name":"fromjson"}' })).toEqual({ config: { name: "fromjson" }, source: "_drop.json" });
  expect(loadSiteConfig({})).toBeUndefined();
  expect(CONFIG_FILE_YAML).toBe("drop.yaml");
  expect(CONFIG_FILE_JSON).toBe("_drop.json");
});
