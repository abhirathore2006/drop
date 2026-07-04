// Mirrors src/names.ts's validateName EXACTLY (same regex, same reserved set) instead of
// importing it directly. Direct import doesn't survive the console's browser bundling:
// that module's generateName() imports node:crypto for randomBytes, and Rollup fails hard
// resolving that import when bundling for the browser (Vite stubs node:crypto with an
// empty module that has no `randomBytes` export) — even though generateName is never
// called from here. Dead-code elimination only runs AFTER Rollup binds every top-level
// import in a module it has to load, so the mere presence of the node:crypto import
// anywhere in the file breaks the build regardless of which export we actually use
// (confirmed: `node build.mjs ui` errors on exactly this if src/names.ts is imported
// as-is). validateName.test.ts locks this copy to the real server-side implementation
// with a shared input sweep — the same "mirror + shared-table test" pattern
// console/src/lib/status.ts uses for src/api/status.ts.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(["www", "api", "admin", "drop", "app", "edge", "internal", "static"]);

/** Returns an error message, or null if `name` is a valid, non-reserved DNS label. */
export function validateName(name: string): string | null {
  if (!LABEL.test(name)) {
    return `invalid site name "${name}": must be a lowercase DNS label`;
  }
  // Reserved for preview/environment hostnames (E1: `<name>--<label>.<baseDomain>`) — mirrors
  // src/names.ts EXACTLY (see its comment: LABEL alone doesn't exclude "--", so this is real logic).
  if (name.includes("--")) {
    return `invalid site name "${name}": "--" is reserved for preview/environment hostnames (<name>--<label>)`;
  }
  if (RESERVED.has(name)) return `site name "${name}" is reserved`;
  return null;
}
