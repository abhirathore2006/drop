import { Hono } from "hono";
import type { Context } from "hono";
import { posix } from "node:path";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import type { BlobStore } from "../blob/types.ts";
import { MetaStore } from "../metastore/store.ts";
import { PreviewStore } from "../previews/store.ts";
import { DiskCache } from "./disk-cache.ts";
import type { Collector } from "../metrics/collector.ts";
import type { SiteConfig } from "../site-config.ts";
import type { Visibility, WorkloadType } from "../metastore/types.ts";
import { basicAuthOk, corsHeaders, headersForPath, matchRedirect, passwordHashOk } from "../site-config.ts";

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
  /** KEDA HTTP interceptor base URL (e.g. http://keda-add-ons-http-interceptor-proxy.keda:8080).
   *  type=app hostnames reverse-proxy here; the interceptor routes by Host and wakes the pod. */
  interceptorUrl?: string;
  /** (E1) Preview registry — resolves `<site>--<label>` hosts to a specific version. Optional and
   *  gracefully degraded, same posture as `interceptorUrl`: without it, every preview host 404s
   *  rather than crashing an instance that hasn't wired one up. */
  previews?: PreviewStore;
  /** (G2) In-process traffic collector. When set, EVERY served/proxied response is metered by the
   *  resolved serving host (site or `site--label`); the entrypoint flushes it to `traffic_minutes`.
   *  Optional + gracefully absent (tests, or an instance with metrics off) — same posture as previews. */
  metrics?: Collector;
}

interface CacheEntry {
  type: WorkloadType;
  version: string | null;
  config?: SiteConfig;
  visibility: Visibility;
  passwordHash: string | null;
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
  const interceptor = d.interceptorUrl ? new URL(d.interceptorUrl) : null;

  // Hop-by-hop headers (RFC 7230 §6.1) — never forwarded across a proxy hop.
  const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate"]);

  /** Reverse-proxy a type=app request to the in-cluster KEDA interceptor, which
   *  routes by Host to the tenant's HTTPScaledObject and wakes the pod from zero.
   *  Uses node:http.request (NOT fetch — fetch forbids overriding the Host header,
   *  which KEDA routes on). Streams request + response bodies; generous cold-start timeout. */
  function proxyToApp(c: Context, name: string): Promise<Response> {
    if (!interceptor) return Promise.resolve(new Response("app routing not configured", { status: 503 }));
    const host = `${name}.${d.baseDomain}`; // the registered HTTPScaledObject host (NOT a raw pass-through)
    const src = new URL(c.req.url);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    });
    headers.host = host; // override: KEDA matches this against HTTPScaledObject.spec.hosts
    return new Promise<Response>((resolve) => {
      const upstream = httpRequest(
        {
          protocol: interceptor.protocol,
          hostname: interceptor.hostname,
          port: interceptor.port,
          method: c.req.method,
          path: src.pathname + src.search,
          headers,
          timeout: 120_000, // KEDA scale-from-zero cold start can take many seconds
        },
        (res) => {
          const rh = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
            rh.set(k, Array.isArray(v) ? v.join(", ") : String(v));
          }
          resolve(new Response(Readable.toWeb(res) as ReadableStream, { status: res.statusCode ?? 502, headers: rh }));
        },
      );
      upstream.on("timeout", () => {
        upstream.destroy();
        resolve(new Response("upstream timeout", { status: 504 }));
      });
      upstream.on("error", () => resolve(new Response("bad gateway", { status: 502 })));
      const body = c.req.raw.body;
      if (body) {
        const rs = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
        // A client that aborts mid-upload makes `rs` emit 'error'. Without a listener that
        // becomes an uncaughtException that crashes the whole edge replica (cross-tenant
        // DoS). Forward the failure to the upstream socket → it tears down and resolves 502.
        rs.on("error", (e) => upstream.destroy(e instanceof Error ? e : new Error(String(e))));
        rs.pipe(upstream);
      } else {
        upstream.end();
      }
    });
  }

  /** Resolve + cache a host label's serving pointer. A plain site host resolves straight off
   *  `sites`; a `<site>--<label>` PREVIEW host (E1) resolves through the previews registry to a
   *  SPECIFIC version instead of `current_version`, while inheriting the parent site's
   *  visibility/password/config verbatim (never its own — previews don't carry independent access
   *  settings). The cache keys on the WHOLE resolved host label, so a preview naturally gets its own
   *  entry keyed on (site,label) alongside the parent's own (unlabeled) entry — same TTL semantics,
   *  including caching a miss (unknown site OR unknown/expired preview) for the TTL window. */
  async function current(name: string): Promise<CacheEntry> {
    const hit = cache.get(name);
    if (hit && now() < hit.exp) return hit;
    const preview = parsePreviewHost(name);
    const ptr = await d.meta.getPointer(preview ? preview.site : name);
    let type = ptr?.type ?? "site";
    let version = ptr?.currentVersion ?? null;
    if (preview) {
      type = "site"; // E1 previews are static-site only; a non-site parent resolves to a miss below
      const row = ptr && ptr.type === "site" && d.previews ? await d.previews.get(preview.site, preview.label) : null;
      const expired = !row || new Date(row.expiresAt).getTime() <= now();
      version = row && !expired ? row.versionId : null;
    }
    const entry: CacheEntry = {
      type,
      version,
      config: ptr?.config,
      visibility: ptr?.visibility ?? "public",
      passwordHash: ptr?.passwordHash ?? null,
      exp: now() + ttl,
    };
    cache.set(name, entry);
    return entry;
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
      // Explicit content-length (the body is a known-size Uint8Array): makes G2 byte accounting exact
      // for the dominant static-serve path (a Response from a byte body doesn't expose length otherwise).
      "content-length": String(c.body.byteLength),
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
    const start = now();
    const res = await handleSiteRequest(c);
    // Re-derive the host label the same way handleSiteRequest did (cheap, no DB) — it's both the
    // preview-noindex trigger AND the G2 metering key. Metering is keyed on the WHOLE label so a
    // preview host (`site--label`) rolls up separately from its parent (matches the plan's granularity).
    const label = siteFromHost(c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "", d.baseDomain);
    // (G2) Meter EVERY response the edge produced — static serve, app proxy, redirect, and every
    // access denial (401/403) alike. bytes_out is the response content-length when known (static serves
    // set it explicitly; a proxied app forwards the upstream's); a streamed/chunked body with no
    // content-length contributes 0 bytes (documented approximation — WS/TCP byte counts are exact).
    if (d.metrics && label) {
      d.metrics.record(label, {
        status: res.status,
        bytesIn: Number(c.req.header("content-length")) || 0,
        bytesOut: Number(res.headers.get("content-length")) || 0,
        ms: now() - start,
      });
    }
    // (E1) Preview hosts (`<site>--<label>.<baseDomain>`) must never be indexed — stamp the header
    // on EVERY response for a preview host (200s, redirects, denials, 404s alike), not just
    // successful serves.
    if (label && parsePreviewHost(label)) {
      const headers = new Headers(res.headers);
      headers.set("x-robots-tag", "noindex");
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  });

  async function handleSiteRequest(c: Context): Promise<Response> {
    // Prefer the proxy-forwarded host (nginx locally, ALB/ingress in prod) so
    // the site name survives a reverse proxy; fall back to the direct Host header.
    const rawLabel = siteFromHost(c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "", d.baseDomain);
    if (!rawLabel) return notFound("site not found");
    // (E1) A `<site>--<label>` host is a PREVIEW: `current()` resolves it through the previews
    // registry to a specific version instead of current_version. `siteName` is always the PARENT
    // site — byte storage (filesPrefix) and app-proxy routing are keyed on it, never on the
    // combined host label.
    const preview = parsePreviewHost(rawLabel);
    const siteName = preview ? preview.site : rawLabel;

    const { type, version, config: cfg, visibility, passwordHash } = await current(rawLabel);
    const config = cfg ?? {};
    // type=app: reverse-proxy to the interceptor (KEDA wakes + routes by Host). Apps
    // don't use the static-site machinery below (S3 bytes, redirects, SPA fallback).
    if (type === "app") {
      if (!version) return notFound("app not found or not deployed");
      return proxyToApp(c, siteName);
    }
    if (!version) {
      return notFound(preview ? `preview "${preview.label}" not found or expired` : "site not found or nothing published");
    }
    const prefix = d.meta.filesPrefix(siteName, version);

    const urlPath = "/" + posix.normalize("/" + c.req.path).replace(/^\/+/, "");
    const cors = corsHeaders(c.req.header("origin"), config.cors);

    // 0+1. Visibility (private fails closed — viewer auth lands in a later feature) +
    // password gate, via the shared helper the WS upgrade path reuses verbatim. A preview inherits
    // the PARENT site's gate verbatim (E1) — same visibility/password, never its own.
    const denial = checkAccessGate({ visibility, passwordHash, config }, c.req.header("authorization"));
    if (denial) return new Response(denial.body, { status: denial.status, headers: denial.headers });
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
  }

  return app;
}

/** Fall back to index.html only for HTML navigations with no file extension. */
function isNavigationRoute(accept: string, reqPath: string): boolean {
  if (posix.extname(reqPath) !== "") return false; // looks like an asset
  return accept === "" || accept.includes("text/html") || accept.includes("*/*");
}

/** Resolve a request Host to its site name: `<label>.<baseDomain>` → `<label>` (a single
 *  DNS label; anything else — the apex, a nested label, a foreign domain — is null).
 *  Module-level + exported so the WS upgrade path resolves hosts identically. */
export function siteFromHost(host: string, baseDomain: string): string | null {
  const h = host.split(":")[0] ?? "";
  const suffix = "." + baseDomain;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  return label;
}

/** Split a resolved site-host label on the E1 preview separator: `<site>--<label>` → {site,label}.
 *  `--` is reserved in BOTH site names (src/names.ts) and preview labels (src/previews/store.ts)
 *  precisely so this split is always unambiguous — neither half can itself contain "--". Returns
 *  null for a plain (non-preview) host, or for a malformed split (an empty half) — which just falls
 *  through to an ordinary "not found" rather than ever being treated as a valid preview. */
export function parsePreviewHost(label: string): { site: string; label: string } | null {
  const i = label.indexOf("--");
  if (i < 0) return null;
  const site = label.slice(0, i);
  const previewLabel = label.slice(i + 2);
  if (!site || !previewLabel) return null;
  return { site, label: previewLabel };
}

/** The inputs the access gate needs — the lean pointer fields, no request object. */
export interface AccessGateInput {
  visibility: Visibility;
  passwordHash: string | null;
  config: SiteConfig;
}

/** A denied request: the status + body + headers to write back (HTTP Response or raw socket). */
export interface AccessDenial {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

/** The single source of truth for the visibility + password gate, shared by the HTTP
 *  handler and the pre-upgrade WebSocket handler so both fail closed identically. Returns
 *  a denial to write back, or null when the request may proceed. */
export function checkAccessGate(input: AccessGateInput, authHeader: string | undefined): AccessDenial | null {
  // Visibility: private fails closed (viewer auth lands in a later feature).
  if (input.visibility === "private") {
    return {
      status: 403,
      body: "This site is private. Viewer authentication is coming soon.",
      headers: { "content-type": "text/plain; charset=utf-8" },
    };
  }
  // Password gate — when the bundle carries basicAuth or a visibility password is set.
  const cfg = input.config;
  const needsAuth = !!cfg.basicAuth || (input.visibility === "password" && !!input.passwordHash);
  if (needsAuth) {
    const okCfg = cfg.basicAuth ? basicAuthOk(authHeader, cfg.basicAuth.users) : false;
    const okHash = input.passwordHash ? passwordHashOk(authHeader, input.passwordHash) : false;
    if (!okCfg && !okHash) {
      return {
        status: 401,
        body: "Authentication required",
        headers: { "www-authenticate": `Basic realm="${cfg.basicAuth?.realm ?? "Drop"}"` },
      };
    }
  }
  return null;
}
