#!/usr/bin/env node
// M5 perf budget — fails CI when the console's INITIAL (non-lazy) JavaScript exceeds the budget.
//
// It reads the Vite build manifest (dist/ui/.vite/manifest.json, emitted because vite.config.ts
// sets `build.manifest: true`), walks the STATIC-import closure of the entry chunk to find the
// bytes that ship on first paint, gzips them, and compares against BUDGET_BYTES. It also asserts
// the heavy libraries (canvas/xyflow, xterm, uPlot, fflate, the tar writer) are reachable ONLY as
// lazy `dynamicImports` — never in the initial closure — so a stray static import that would drag
// one back into the entry fails loudly.
//
// Usage:  node scripts/check-bundle.mjs        (run `node build.mjs ui` first)
//         npm run check:bundle
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "ui");
const MANIFEST = join(DIST, ".vite", "manifest.json");
const BUDGET_BYTES = 250 * 1024; // 250 KB gzipped, per Plan-v5 M5.

// Libraries the plan mandates stay in lazy chunks. Matched (substring) against each chunk's
// manifest key / rollup name / emitted filename.
const HEAVY = [
  { label: "xterm", patterns: ["xterm"] },
  { label: "xyflow/canvas", patterns: ["xyflow", "react-flow", "StackNodeBody", "StackCanvas", "EditableStackCanvas"] },
  { label: "uPlot/chart", patterns: ["uplot", "uPlot", "Chart"] },
  { label: "fflate", patterns: ["fflate"] },
  { label: "tar/publish", patterns: ["publish", "/tar", "tar-"] },
];

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

if (!existsSync(MANIFEST)) {
  die(`no build manifest at ${MANIFEST}\n  run \`node build.mjs ui\` first (vite.config.ts must set build.manifest: true).`);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const entries = Object.entries(manifest).filter(([, v]) => v.isEntry);
if (!entries.length) die("manifest has no entry chunk (isEntry)");

// Static-import closure from every entry chunk = the initial JS graph.
const initial = new Set();
const queue = entries.map(([k]) => k);
while (queue.length) {
  const key = queue.shift();
  if (initial.has(key)) continue;
  initial.add(key);
  for (const imp of manifest[key]?.imports ?? []) queue.push(imp);
  // NB: dynamicImports are deliberately NOT followed — they are the lazy boundary.
}

const jsFile = (key) => manifest[key]?.file;
const gzOf = (file) => (file && file.endsWith(".js") ? gzipSync(readFileSync(join(DIST, file))).length : 0);

// Tally the initial JS.
let initialBytes = 0;
const initialRows = [];
for (const key of initial) {
  const file = jsFile(key);
  const bytes = gzOf(file);
  if (bytes > 0) {
    initialBytes += bytes;
    initialRows.push({ key, file, bytes });
  }
}
initialRows.sort((a, b) => b.bytes - a.bytes);

// Which chunk (by key/name/file) matches a heavy pattern?
const heavyMatch = (key) => {
  const v = manifest[key] ?? {};
  const hay = `${key} ${v.name ?? ""} ${v.file ?? ""}`.toLowerCase();
  for (const h of HEAVY) if (h.patterns.some((p) => hay.includes(p.toLowerCase()))) return h.label;
  return null;
};

// A heavy chunk in the initial closure is a budget violation.
const leaked = [...initial].map((k) => ({ k, label: heavyMatch(k) })).filter((x) => x.label && jsFile(x.k)?.endsWith(".js"));

// Confirm the heavy libs are present-and-lazy (informational — a missing lib is fine).
const allKeys = Object.keys(manifest);
const lazyHeavy = HEAVY.map((h) => {
  const keys = allKeys.filter((k) => {
    if (initial.has(k)) return false;
    const v = manifest[k] ?? {};
    const hay = `${k} ${v.name ?? ""} ${v.file ?? ""}`.toLowerCase();
    return h.patterns.some((p) => hay.includes(p.toLowerCase())) && (v.file ?? "").endsWith(".js");
  });
  return { label: h.label, keys };
});

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log("console initial JS (gzipped):");
for (const r of initialRows) console.log(`  ${kb(r.bytes).padStart(10)}  ${r.file}`);
console.log(`  ${"".padStart(10, "-")}`);
console.log(`  ${kb(initialBytes).padStart(10)}  TOTAL initial   (budget ${kb(BUDGET_BYTES)})`);
console.log("");
console.log("lazy chunks (loaded on demand):");
for (const { label, keys } of lazyHeavy) {
  if (!keys.length) {
    console.log(`  ${label.padEnd(16)} — not found (unused or inlined elsewhere)`);
    continue;
  }
  for (const k of keys) console.log(`  ${label.padEnd(16)} ${kb(gzOf(jsFile(k))).padStart(9)}  ${jsFile(k)}`);
}
console.log("");

let failed = false;
if (leaked.length) {
  failed = true;
  console.error("\x1b[31m✗ heavy libs leaked into the initial bundle (must be lazy):\x1b[0m");
  for (const { k, label } of leaked) console.error(`    ${label}: ${jsFile(k)} (${k})`);
}
if (initialBytes > BUDGET_BYTES) {
  failed = true;
  console.error(`\x1b[31m✗ initial JS ${kb(initialBytes)} exceeds the ${kb(BUDGET_BYTES)} budget\x1b[0m`);
}
if (failed) process.exit(1);

console.log(`\x1b[32m✓ initial JS ${kb(initialBytes)} ≤ ${kb(BUDGET_BYTES)} budget; heavy libs are lazy\x1b[0m`);
