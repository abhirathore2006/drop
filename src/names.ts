const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set([
  "www", "api", "admin", "drop", "app", "edge", "internal", "static",
]);

/** Returns an error message, or null if `name` is a valid, non-reserved DNS label. */
export function validateName(name: string): string | null {
  if (!LABEL.test(name)) {
    return `invalid site name "${name}": must be a lowercase DNS label`;
  }
  if (RESERVED.has(name)) return `site name "${name}" is reserved`;
  return null;
}
