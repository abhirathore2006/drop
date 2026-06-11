import { Hono } from "hono";
import { posix } from "node:path";
import type { BlobStore } from "../blob/types.ts";
import { MetaStore } from "../metastore/store.ts";

export interface EdgeDeps {
  meta: MetaStore;
  blob: BlobStore;
  baseDomain: string;
  now?: () => number;
  pointerTtlMs?: number;
}

interface CacheEntry {
  version: string | null;
  exp: number;
}

export function createEdge(d: EdgeDeps) {
  const now = d.now ?? (() => Date.now());
  const ttl = d.pointerTtlMs ?? 10_000;
  const cache = new Map<string, CacheEntry>(); // name → currentVersion

  async function currentVersion(name: string): Promise<string | null> {
    const hit = cache.get(name);
    if (hit && now() < hit.exp) return hit.version;
    const site = await d.meta.getSitePlain(name);
    const version = site?.currentVersion ?? null;
    cache.set(name, { version, exp: now() + ttl });
    return version;
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

  async function serve(prefix: string, key: string): Promise<Response | null> {
    const obj = await d.blob.get(prefix + key);
    if (!obj) return null;
    const headers: Record<string, string> = { "content-type": obj.contentType };
    if (obj.contentEncoding) headers["content-encoding"] = obj.contentEncoding;
    return new Response(obj.body, { status: 200, headers });
  }

  const app = new Hono();
  app.all("*", async (c) => {
    const name = siteFromHost(c.req.header("host") ?? "");
    if (!name) return notFound("site not found");

    const version = await currentVersion(name);
    if (!version) return notFound("site not found or nothing published");
    const prefix = d.meta.filesPrefix(name, version);

    let reqPath = posix.normalize("/" + c.req.path).replace(/^\/+/, "");
    if (reqPath === "" || reqPath === ".") reqPath = "index.html";

    // 1. exact object
    const exact = await serve(prefix, reqPath);
    if (exact) return exact;

    // 2. route-aware SPA fallback
    if (isNavigationRoute(c.req.header("accept") ?? "", reqPath)) {
      const index = await serve(prefix, "index.html");
      if (index) return index;
    }

    // 3. missing asset (or missing index) → real 404, never HTML for an asset miss
    return notFound("not found");
  });

  return app;
}

/** Fall back to index.html only for HTML navigations with no file extension. */
function isNavigationRoute(accept: string, reqPath: string): boolean {
  if (posix.extname(reqPath) !== "") return false; // looks like an asset
  return accept === "" || accept.includes("text/html") || accept.includes("*/*");
}
