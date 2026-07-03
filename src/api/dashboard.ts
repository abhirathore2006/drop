// Console serving for the Drop admin console — the SPA shell + its static assets, isolated
// here so the API router only needs two calls (consoleShell / consoleAsset). The React app
// is bundled to <cliDir>/ui/ by build.mjs and calls /v1/* with the session cookie.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ConsoleCfg {
  cliDir: string; // dir holding built bundles; the console lives under <cliDir>/ui/
  baseDomain: string;
}

/** The SPA shell served at / and every client-side route (deep links + refresh load it). */
export function consoleShell(_cfg: ConsoleCfg): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>drop · console</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
<div id="root"></div>
<script src="/ui/app.js"></script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
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
