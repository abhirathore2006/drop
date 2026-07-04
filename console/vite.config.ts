// Vite project root for the Drop console (React SPA). Built to ../dist/ui with hashed
// assets; served statically by the API (src/api/dashboard.ts) under /ui/* with the SPA
// shell at /, /admin, /{site,app,database}/:name. `node build.mjs ui` shells out here.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

// Local API origin for the dev proxy. `make start` runs the API on :8473 (Makefile
// API_PORT; the bare Config default is 8080 but local dev always overrides it).
// Point elsewhere with DROP_API_ORIGIN.
const api = process.env.DROP_API_ORIGIN ?? "http://localhost:8473";

// Same-origin API + auth routes are proxied so session cookies flow unchanged
// (cookies are host-scoped, not port-scoped, so localhost:5173 shares them).
const proxy = Object.fromEntries(
  ["/v1", "/auth", "/version", "/login", "/logout", "/docs"].map((p) => [p, { target: api, changeOrigin: true }]),
);

export default defineConfig(({ command }) => ({
  root,
  // Production assets live under /ui/ (the API serves them there). In dev the SPA is
  // served at / so the real routes (/site/:name, /admin, …) hit Vite's SPA fallback.
  base: command === "build" ? "/ui/" : "/",
  plugins: [react()],
  resolve: { alias: { "@": resolve(root, "src") } },
  // `manifest: true` emits dist/ui/.vite/manifest.json — the entry/import/dynamic-import graph the
  // M5 perf budget (scripts/check-bundle.mjs) reads to sum the INITIAL (non-lazy) JS and assert the
  // heavy libs (canvas/xterm/uPlot/fflate) stay in lazy chunks.
  build: { outDir: resolve(root, "../dist/ui"), emptyOutDir: true, manifest: true },
  server: { port: 5173, proxy },
}));
