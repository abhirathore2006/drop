import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDropYaml, CONFIG_FILE_YAML } from "../site-config.ts";
import { validateName, generateName } from "../names.ts";

export type NameSource = "arg" | "drop.yaml" | "generated";

/**
 * Resolve the target site name for a publish, in order:
 *   1. explicit CLI/tool argument
 *   2. `site.name` in the bundle's drop.yaml
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
    const cfg = parseDropYaml(await readFile(join(dir, CONFIG_FILE_YAML), "utf8"));
    if (cfg.name) return { name: cfg.name, source: "drop.yaml" };
  } catch {
    /* no drop.yaml (or unreadable/invalid) → fall through to generate */
  }
  return { name: generateName(), source: "generated" };
}
