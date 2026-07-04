// Console serving for the Drop admin console — the SPA shell + its static assets, isolated
// here so the API router only needs two calls (consoleShell / consoleAsset). The console is
// a Vite app (console/) built to <cliDir>/ui/ by `node build.mjs ui`: an index.html shell
// plus content-hashed assets/* — it calls /v1/* with the session cookie.
import { readFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface ConsoleCfg {
  cliDir: string; // dir holding built bundles; the console lives under <cliDir>/ui/
  baseDomain: string;
}

const NONCE_PLACEHOLDER = "__CSP_STYLE_NONCE__"; // stamped into console/index.html's meta at build

// Strict same-origin CSP. script-src stays 'self' with NO 'unsafe-inline' — the load-bearing XSS
// defense (the Vite build emits only external hashed scripts). style-src is 'self' PLUS a
// per-response nonce: 'self' still covers the external hashed stylesheets, and the nonce admits
// xterm's runtime-injected <style> elements (M3 terminal) WITHOUT ever allowing 'unsafe-inline'.
// The nonce also matches the <meta name="csp-style-nonce"> the shell carries, so the terminal can
// stamp it onto those style elements at mount. Everything else (img/connect/font/default) is 'self',
// so even a hypothetical injected style has no host to exfiltrate to.
const cspFor = (nonce: string): string =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`;

const shellHeaders = (nonce: string): Record<string, string> => ({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": cspFor(nonce),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cache-control": "no-cache", // the shell must revalidate; its hashed assets are immutable
});

// Self-contained "not built yet" page (dev / fresh clone). Deliberately style-free: it must
// not violate the style-src 'self' CSP above, and / must never 500 just because the console
// bundle is absent.
const NOT_BUILT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>drop · console (not built)</title>
</head>
<body>
<main>
<h1>&#9656; drop console</h1>
<p>The console bundle isn't built yet. Build it with:</p>
<pre><code>node build.mjs ui</code></pre>
<p>then reload this page. The API itself is running &mdash; only the web console is missing.</p>
</main>
</body>
</html>`;

// Lazily-read shell, cached in memory and invalidated by mtime/size — a redeploy that
// replaces dist/ui/index.html is picked up without restarting the API.
let shellCache: { mtimeMs: number; size: number; html: string } | null = null;

/** The SPA shell served at / and every client-side route (deep links + refresh load it).
 *  A fresh style nonce per response is stamped into both the CSP header and the shell's
 *  meta tag (so they always match — a stale cached HTML never carries a live nonce). */
export function consoleShell(cfg: ConsoleCfg): Response {
  const path = join(cfg.cliDir, "ui", "index.html");
  const nonce = randomBytes(16).toString("base64url");
  try {
    const st = statSync(path);
    if (!shellCache || shellCache.mtimeMs !== st.mtimeMs || shellCache.size !== st.size) {
      shellCache = { mtimeMs: st.mtimeMs, size: st.size, html: readFileSync(path, "utf8") };
    }
    const html = shellCache.html.replaceAll(NONCE_PLACEHOLDER, nonce);
    return new Response(html, { headers: shellHeaders(nonce) });
  } catch {
    shellCache = null;
    return new Response(NOT_BUILT_HTML, { headers: shellHeaders(nonce) });
  }
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".html": "text/html; charset=utf-8",
};

/** A console static asset under /ui/<subpath>. Rejects traversal; content-hashed files
 *  (under assets/) are served immutable, everything else no-cache. */
export async function consoleAsset(cfg: ConsoleCfg, subpath: string): Promise<Response> {
  // Fail closed on anything that could escape <cliDir>/ui: absolute paths, `..` segments,
  // backslashes, NUL. (join() would happily resolve `..` upward.)
  if (!subpath || subpath.startsWith("/") || subpath.includes("\\") || subpath.includes("\0") || subpath.split("/").includes("..")) {
    return new Response("not found", { status: 404 });
  }
  const ext = subpath.slice(subpath.lastIndexOf("."));
  try {
    const buf = await readFile(join(cfg.cliDir, "ui", subpath));
    return new Response(buf, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": subpath.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
