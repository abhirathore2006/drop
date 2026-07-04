// Bundles the entrypoints into node-runnable ESM with esbuild.
//   node build.mjs            → builds everything (cli + mcp + api + edge + edge-tcp)
//   node build.mjs cli mcp    → builds only the named targets (prepare uses this for npx)
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  { tag: "edge-tcp", entry: "bin/edge-tcp.ts", out: "dist/edge-tcp.js" },
];

for (const t of targets) {
  if (only.length && !only.includes(t.tag)) continue;
  await build({ ...common, entryPoints: [t.entry], outfile: t.out });
  console.log(`✓ built ${t.out}`);
}

// Published workspace packages (K2). Zero-runtime-dep ESM libraries built neutral (usable in Node, edge
// runtimes, and browser bundles). `node:crypto` (used only by @drop/auth's server-side verifyRequest, via
// a lazy dynamic import) is kept external so it stays a runtime import and never bundles a Node builtin
// into a browser graph — harmless for packages that don't touch it (@drop/config). "Published" here =
// built + packable (npm pack), NOT npm-published. Built by `node build.mjs` (no args) / `… packages`.
if (!only.length || only.includes("packages")) {
  const pkgs = [
    { name: "@drop/auth", entry: "packages/auth/src/index.ts", out: "packages/auth/dist/index.js" },
    { name: "@drop/config", entry: "packages/config/src/index.ts", out: "packages/config/dist/index.js" }, // (L4) runtime-config SDK
  ];
  for (const p of pkgs) {
    await build({ bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["node:crypto"], entryPoints: [p.entry], outfile: p.out });
    console.log(`✓ built ${p.out} (${p.name})`);
  }
}

// The admin console — a proper Vite app (console/, React + wouter + TanStack Query) built
// to dist/ui/ (index.html shell + content-hashed assets/*). Served as static files by the
// API (src/api/dashboard.ts); it never enters the api/edge node bundles, which stay
// React-free. Shelled out so esbuild stays the only bundler for the node targets.
if (!only.length || only.includes("ui")) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const viteBin = fileURLToPath(new URL("./node_modules/vite/bin/vite.js", import.meta.url));
  const r = spawnSync(process.execPath, [viteBin, "build", "--config", "console/vite.config.ts"], {
    stdio: "inherit",
    cwd: here,
  });
  if (r.status !== 0) {
    console.error("✗ vite build failed for the console (dist/ui)");
    process.exit(r.status ?? 1);
  }
  console.log("✓ built dist/ui (console)");
}
