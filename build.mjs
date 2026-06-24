// Bundles the entrypoints into node-runnable ESM with esbuild.
//   node build.mjs            → builds everything (cli + mcp + api + edge)
//   node build.mjs cli mcp    → builds only the named targets (prepare uses this for npx)
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const only = process.argv.slice(2);

// Version baked into every node bundle: <pkg.version>+<git-short-sha>. The sha makes it change per
// commit so `drop --version` / `drop update` are meaningful; falls back to bare pkg.version off-git.
const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
let gitSha = "";
try {
  gitSha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  /* not a git checkout — ship the bare version */
}
const VERSION = gitSha ? `${pkgVersion}+${gitSha}` : pkgVersion;

const banner = {
  // Bundled CJS deps (commander, parts of aws-sdk) use require(); provide one in ESM.
  js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
};
const common = { bundle: true, platform: "node", format: "esm", target: "node24", banner, define: { __DROP_VERSION__: JSON.stringify(VERSION) } };
console.log(`building drop ${VERSION}`);

const targets = [
  { tag: "cli", entry: "bin/drop.ts", out: "dist/drop.js" },
  { tag: "mcp", entry: "bin/mcp.ts", out: "dist/mcp.js" },
  { tag: "api", entry: "bin/api.ts", out: "dist/api.js" },
  { tag: "edge", entry: "bin/edge.ts", out: "dist/edge.js" },
];

for (const t of targets) {
  if (only.length && !only.includes(t.tag)) continue;
  await build({ ...common, entryPoints: [t.entry], outfile: t.out });
  console.log(`✓ built ${t.out}`);
}

// The admin console (React) — a BROWSER bundle (IIFE, no node banner/require). Served as a
// static asset by the API; it never enters the api/edge node bundles, which stay React-free.
if (!only.length || only.includes("ui")) {
  await build({
    entryPoints: ["src/ui/main.tsx"],
    outfile: "dist/ui/app.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  console.log("✓ built dist/ui/app.js");
}
