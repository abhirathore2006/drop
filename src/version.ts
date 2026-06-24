// Build-time version, injected by esbuild's `define` (build.mjs) as `<pkg.version>+<git-short-sha>`.
// When run unbundled (e.g. `bun test`, or `bun run bin/drop.ts`) the define isn't applied, so we
// fall back to "dev" — `typeof` on the (then-undeclared) identifier is safe and never throws.
declare const __DROP_VERSION__: string | undefined;
export const VERSION: string = typeof __DROP_VERSION__ !== "undefined" ? (__DROP_VERSION__ as string) : "dev";
