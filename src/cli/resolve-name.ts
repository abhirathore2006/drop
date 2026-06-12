import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSiteConfig } from "../site-config.ts";
import { validateName, generateName } from "../names.ts";

export type NameSource = "arg" | "_drop.json" | "generated";

/**
 * Resolve the target site name for a publish, in order:
 *   1. explicit CLI/tool argument
 *   2. `name` in the bundle's `_drop.json`
 *   3. a generated name
 * Shared by the CLI and the MCP server so `drop publish ./dist` "just works".
 */
export async function resolveSiteName(
  dir: string,
  argName?: string,
): Promise<{ name: string; source: NameSource }> {
  if (argName) {
    const err = validateName(argName);
    if (err) throw new Error(err);
    return { name: argName, source: "arg" };
  }
  try {
    const cfg = parseSiteConfig(await readFile(join(dir, "_drop.json"), "utf8"));
    if (cfg.name) return { name: cfg.name, source: "_drop.json" };
  } catch {
    /* no _drop.json (or unreadable/invalid) → fall through to generate */
  }
  return { name: generateName(), source: "generated" };
}
