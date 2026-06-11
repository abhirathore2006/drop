import { Hono } from "hono";
import { posix } from "node:path";
import type { BlobStore } from "../blob/types.ts";
import { MetaStore } from "../metastore/store.ts";
import { DiskCache } from "./disk-cache.ts";

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

  function respond(c: Cached): Response {
    const headers: Record<string, string> = {
      "content-type": c.contentType,
      // HTML is the entry point (re-resolved per deploy) → always revalidate.
      // Other assets are safe to cache for a while.
      "cache-control": c.contentType.includes("text/html") ? "no-cache" : "public, max-age=300",
    };
    if (c.contentEncoding) headers["content-encoding"] = c.contentEncoding;
    return new Response(c.body, { status: 200, headers });
  }

  async function serve(prefix: string, key: string): Promise<Response | null> {
    const full = prefix + key;

    // Disk cache (if enabled). Hot files are served from the OS page cache (RAM
    // speed); the versioned path is immutable, so it never goes stale.
    if (disk) {
      const dh = await disk.get(full);
      if (dh) return respond(dh);
    }

    // Origin: S3.
    const obj = await d.blob.get(full);
    if (!obj) return null;

    // Write small objects to the disk cache, then serve. Stream large objects
    // (or, with no disk cache configured, everything) straight through.
    if (disk && obj.size != null && obj.size <= maxObjectBytes) {
      const body = new Uint8Array(await new Response(obj.body).arrayBuffer());
      const entry: Cached = { body, contentType: obj.contentType, contentEncoding: obj.contentEncoding };
      void disk.set(full, entry);
      return respond(entry);
    }
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
