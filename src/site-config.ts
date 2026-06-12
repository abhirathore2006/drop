import { createHash, timingSafeEqual } from "node:crypto";
import { validateName } from "./names.ts";

// Per-site config, published as `_drop.json` at the site root. The API parses it
// at publish time (it is NOT served as a file); the edge applies it per request.
export interface SiteConfig {
  name?: string; // site name — lets `drop publish ./dist` identify the target from the bundle
  spaFallback?: string | false; // doc to serve for navigation misses (default "index.html"); false disables
  notFound?: string; // custom 404 document (served with 404)
  cleanUrls?: boolean; // /about → try /about.html
  redirects?: Redirect[];
  headers?: HeaderRule[]; // custom response headers (incl. cache-control) by path glob
  cors?: boolean | CorsConfig;
  basicAuth?: { realm?: string; users: Record<string, string> }; // password plain or "sha256:<hex>"
}
export interface Redirect {
  from: string;
  to: string;
  status?: number;
}
export interface HeaderRule {
  source: string; // glob, e.g. "/assets/*"
  headers: Record<string, string>;
}
export interface CorsConfig {
  allowOrigins?: string[]; // default ["*"]
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  maxAge?: number;
  credentials?: boolean;
}

const MAX = 500; // cap list lengths

function str(v: unknown, max = 2048): string | undefined {
  return typeof v === "string" && v.length <= max ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x) => typeof x === "string").slice(0, MAX) as string[];
}

/** Parse + sanitize a `_drop.json` body. Throws on invalid JSON; ignores junk fields. */
export function parseSiteConfig(text: string): SiteConfig {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const cfg: SiteConfig = {};

  const name = str(raw.name, 63);
  if (name && validateName(name) === null) cfg.name = name;

  if (raw.spaFallback === false) cfg.spaFallback = false;
  else if (str(raw.spaFallback)) cfg.spaFallback = str(raw.spaFallback);
  if (str(raw.notFound)) cfg.notFound = str(raw.notFound);
  if (typeof raw.cleanUrls === "boolean") cfg.cleanUrls = raw.cleanUrls;

  if (Array.isArray(raw.redirects)) {
    const out: Redirect[] = [];
    for (const r of (raw.redirects as any[]).slice(0, MAX)) {
      const from = str(r?.from);
      const to = str(r?.to);
      if (from && to) out.push({ from, to, status: typeof r?.status === "number" ? r.status : undefined });
    }
    cfg.redirects = out;
  }
  if (Array.isArray(raw.headers)) {
    const out: HeaderRule[] = [];
    for (const h of (raw.headers as any[]).slice(0, MAX)) {
      const source = str(h?.source);
      if (!source || !h?.headers || typeof h.headers !== "object") continue;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(h.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      out.push({ source, headers });
    }
    cfg.headers = out;
  }
  if (raw.cors === true) cfg.cors = true;
  else if (raw.cors && typeof raw.cors === "object") {
    const c = raw.cors as any;
    cfg.cors = {
      allowOrigins: strArr(c.allowOrigins),
      allowMethods: strArr(c.allowMethods),
      allowHeaders: strArr(c.allowHeaders),
      exposeHeaders: strArr(c.exposeHeaders),
      maxAge: typeof c.maxAge === "number" ? c.maxAge : undefined,
      credentials: c.credentials === true,
    };
  }
  if (raw.basicAuth && typeof raw.basicAuth === "object") {
    const b = raw.basicAuth as any;
    if (b.users && typeof b.users === "object") {
      const users: Record<string, string> = {};
      for (const [u, p] of Object.entries(b.users)) if (typeof p === "string") users[u] = p;
      if (Object.keys(users).length) cfg.basicAuth = { realm: str(b.realm), users };
    }
  }
  return cfg;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function globToRe(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map(escapeRe).join("(.*)") + "$");
}

/** First matching redirect for `path` (leading-slash), with `:splat` substitution. */
export function matchRedirect(path: string, redirects: Redirect[] = []): { to: string; status: number } | null {
  for (const r of redirects) {
    const m = globToRe(r.from).exec(path);
    if (m) {
      const to = m.length > 1 ? r.to.replace(/:splat/g, m[1] ?? "") : r.to;
      return { to, status: r.status && r.status >= 300 && r.status < 400 ? r.status : 301 };
    }
  }
  return null;
}

/** Merge custom header rules whose glob matches `path`. */
export function headersForPath(path: string, rules: HeaderRule[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) if (globToRe(rule.source).test(path)) Object.assign(out, rule.headers);
  return out;
}

function pwMatches(provided: string, stored: string): boolean {
  let expected = stored;
  let actual = provided;
  if (stored.startsWith("sha256:")) {
    expected = stored.slice(7).toLowerCase();
    actual = createHash("sha256").update(provided).digest("hex");
  }
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validate an `Authorization: Basic` header against the config's users. */
export function basicAuthOk(header: string | undefined, users: Record<string, string>): boolean {
  if (!header || !/^basic /i.test(header)) return false;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const stored = users[decoded.slice(0, i)];
  return stored !== undefined && pwMatches(decoded.slice(i + 1), stored);
}

/** CORS headers for a response (and preflight). Empty if not allowed. */
export function corsHeaders(origin: string | undefined, cors: SiteConfig["cors"]): Record<string, string> {
  if (!cors) return {};
  const c = cors === true ? ({} as CorsConfig) : cors;
  const origins = c.allowOrigins ?? ["*"];
  let allow = "";
  if (origins.includes("*")) allow = c.credentials ? origin ?? "" : "*";
  else if (origin && origins.includes(origin)) allow = origin;
  if (!allow) return {};
  const h: Record<string, string> = { "access-control-allow-origin": allow };
  if (allow !== "*") h["vary"] = "Origin";
  if (c.credentials) h["access-control-allow-credentials"] = "true";
  h["access-control-allow-methods"] = (c.allowMethods ?? ["GET", "HEAD", "OPTIONS"]).join(", ");
  if (c.allowHeaders) h["access-control-allow-headers"] = c.allowHeaders.join(", ");
  if (c.exposeHeaders) h["access-control-expose-headers"] = c.exposeHeaders.join(", ");
  if (c.maxAge != null) h["access-control-max-age"] = String(c.maxAge);
  return h;
}
