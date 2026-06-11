import { Hono } from "hono";
import { posix } from "node:path";
import type { BlobStore } from "../blob/types.ts";
import { MetaStore } from "../metastore/store.ts";
import { DiskCache } from "./disk-cache.ts";
import type { SiteConfig } from "../site-config.ts";
import { basicAuthOk, corsHeaders, headersForPath, matchRedirect } from "../site-config.ts";

export interface EdgeDeps {
  meta: MetaStore;
  blob: BlobStore;
  baseDomain: string;
  now?: () => number;
  pointerTtlMs?: number;
  /** Don't disk-cache objects larger than this (default 25 MiB); they stream. */
  maxObjectBytes?: number;
  /** Optional disk cache directory (node-local / per-pod). Off if unset → assets stream from S3. */
  diskCacheDir?: string;
  /** Disk cache budget in bytes (default 5 GiB). */
  diskCacheBytes?: number;
}

interface CacheEntry {
  version: string | null;
  config?: SiteConfig;
  exp: number;
}

interface Cached {
  body: Uint8Array;
  contentType: string;
  contentEncoding?: string;
}

export function createEdge(d: EdgeDeps) {
  const now = d.now ?? (() => Date.now());
  const ttl = d.pointerTtlMs ?? 10_000;
  // Memory holds ONLY small per-site pointers (name → currentVersion). Static
  // asset BYTES never live in process memory — they go to the disk cache, where
  // the OS page cache keeps hot files at RAM speed without risking heap OOM.
  const cache = new Map<string, CacheEntry>();
  const maxObjectBytes = d.maxObjectBytes ?? 25 * 1024 * 1024;
  const disk = d.diskCacheDir ? new DiskCache(d.diskCacheDir, d.diskCacheBytes ?? 5 * 1024 * 1024 * 1024) : null;

  async function current(name: string): Promise<{ version: string | null; config: SiteConfig }> {
    const hit = cache.get(name);
    if (hit && now() < hit.exp) return { version: hit.version, config: hit.config ?? {} };
    const site = await d.meta.getSitePlain(name);
    const entry: CacheEntry = { version: site?.currentVersion ?? null, config: site?.config, exp: now() + ttl };
    cache.set(name, entry);
    return { version: entry.version, config: entry.config ?? {} };
  }

  function siteFromHost(host: string): string | null {
    const h = host.split(":")[0] ?? "";
    const suffix = "." + d.baseDomain;
    if (!h.endsWith(suffix)) return null;
    const label = h.slice(0, -suffix.length);
    if (!label || label.includes(".")) return null;
    return label;
  }

  function notFound(msg: string): Response {
    return new Response(`<!doctype html><title>404</title><h1>404</h1><p>${msg}</p>`, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Final response headers: content-type, a default cache-control (overridable),
  // then per-path config headers, then CORS.
  function buildHeaders(reqUrlPath: string, c: Cached, cfg: SiteConfig, cors: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": c.contentType,
      "cache-control": c.contentType.includes("text/html") ? "no-cache" : "public, max-age=300",
    };
    if (c.contentEncoding) headers["content-encoding"] = c.contentEncoding;
    Object.assign(headers, headersForPath(reqUrlPath, cfg.headers));
    Object.assign(headers, cors);
    return headers;
  }

  // Fetch object bytes: disk cache (if enabled) → S3. Null if missing.
  async function fetchBytes(prefix: string, key: string): Promise<Cached | null> {
    const full = prefix + key;
    if (disk) {
      const dh = await disk.get(full);
      if (dh) return dh;
    }
    const obj = await d.blob.get(full);
    if (!obj) return null;
    if (disk && obj.size != null && obj.size <= maxObjectBytes) {
      const body = new Uint8Array(await new Response(obj.body).arrayBuffer());
      const entry: Cached = { body, contentType: obj.contentType, contentEncoding: obj.contentEncoding };
      void disk.set(full, entry);
      return entry;
    }
    // Stream large / uncached objects.
    const body = new Uint8Array(await new Response(obj.body).arrayBuffer());
    return { body, contentType: obj.contentType, contentEncoding: obj.contentEncoding };
  }

  const app = new Hono();
  // Health endpoint for k8s probes (obscure path → won't shadow real site assets).
  app.get("/_drop_health", (c) => c.text("ok"));
  app.all("*", async (c) => {
    const name = siteFromHost(c.req.header("host") ?? "");
    if (!name) return notFound("site not found");

    const { version, config } = await current(name);
    if (!version) return notFound("site not found or nothing published");
    const prefix = d.meta.filesPrefix(name, version);

    const urlPath = "/" + posix.normalize("/" + c.req.path).replace(/^\/+/, "");
    const cors = corsHeaders(c.req.header("origin"), config.cors);

    // 1. Basic-auth gate (whole site)
    if (config.basicAuth && !basicAuthOk(c.req.header("authorization"), config.basicAuth.users)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "www-authenticate": `Basic realm="${config.basicAuth.realm ?? "Drop"}"` },
      });
    }
    // 2. CORS preflight
    if (c.req.method === "OPTIONS" && config.cors) {
      return new Response(null, { status: 204, headers: cors });
    }
    // 3. Redirects
    const rd = matchRedirect(urlPath, config.redirects);
    if (rd) return new Response(null, { status: rd.status, headers: { location: rd.to, ...cors } });

    const respondWith = async (key: string, status = 200): Promise<Response | null> => {
      const obj = await fetchBytes(prefix, key);
      if (!obj) return null;
      return new Response(obj.body, { status, headers: buildHeaders(urlPath, obj, config, cors) });
    };

    // 4. exact object
    let reqKey = urlPath.replace(/^\/+/, "");
    if (reqKey === "" || reqKey === ".") reqKey = "index.html";
    let res = await respondWith(reqKey);
    if (res) return res;

    // 5. cleanUrls: try "<path>.html"
    if (config.cleanUrls && !posix.extname(reqKey)) {
      res = await respondWith(reqKey + ".html");
      if (res) return res;
    }

    // 6. SPA fallback (configurable doc; default index.html; false disables)
    const fallback = config.spaFallback === undefined ? "index.html" : config.spaFallback;
    if (fallback && isNavigationRoute(c.req.header("accept") ?? "", reqKey)) {
      res = await respondWith(String(fallback).replace(/^\/+/, ""));
      if (res) return res;
    }

    // 7. custom 404 document
    if (config.notFound) {
      res = await respondWith(config.notFound.replace(/^\/+/, ""), 404);
      if (res) return res;
    }
    return notFound("not found");
  });

  return app;
}

/** Fall back to index.html only for HTML navigations with no file extension. */
function isNavigationRoute(accept: string, reqPath: string): boolean {
  if (posix.extname(reqPath) !== "") return false; // looks like an asset
  return accept === "" || accept.includes("text/html") || accept.includes("*/*");
}
