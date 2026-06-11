// Bundles the entrypoints into node-runnable ESM with esbuild.
//   node build.mjs        → builds cli + api + edge
//   node build.mjs cli    → builds only the CLI (used by `prepare` for npx installs)
import { build } from "esbuild";

const only = process.argv[2];
const banner = {
  // Bundled CJS deps (commander, parts of aws-sdk) use require(); provide one in ESM.
  js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
};
const common = { bundle: true, platform: "node", format: "esm", target: "node24", banner };

const targets = [
  { tag: "cli", entry: "bin/drop.ts", out: "dist/drop.js" },
  { tag: "api", entry: "bin/api.ts", out: "dist/api.js" },
  { tag: "edge", entry: "bin/edge.ts", out: "dist/edge.js" },
];

for (const t of targets) {
  if (only && t.tag !== only) continue;
  await build({ ...common, entryPoints: [t.entry], outfile: t.out });
  console.log(`✓ built ${t.out}`);
}
