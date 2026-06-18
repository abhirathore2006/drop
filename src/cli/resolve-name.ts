import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSiteConfig, CONFIG_FILE_YAML, CONFIG_FILE_JSON } from "../site-config.ts";
import { validateName, generateName } from "../names.ts";

export type NameSource = "arg" | "drop.yaml" | "_drop.json" | "generated";

const readOrUndef = async (p: string): Promise<string | undefined> => {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Resolve the target site name for a publish, in order:
 *   1. explicit CLI/tool argument
 *   2. `site.name` in the bundle's drop.yaml (preferred), else `name` in _drop.json
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
    const loaded = loadSiteConfig({
      yaml: await readOrUndef(join(dir, CONFIG_FILE_YAML)),
      json: await readOrUndef(join(dir, CONFIG_FILE_JSON)),
    });
    if (loaded?.config.name) return { name: loaded.config.name, source: loaded.source };
  } catch {
    /* unreadable/invalid config → fall through to generate */
  }
  return { name: generateName(), source: "generated" };
}
