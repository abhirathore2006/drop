import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseSiteConfig, CONFIG_FILE_YAML, CONFIG_FILE_JSON } from "../site-config.ts";

const exists = async (p: string): Promise<boolean> => access(p).then(() => true, () => false);

/** Convert `<dir>/_drop.json` into `<dir>/drop.yaml` (config nested under `site:`).
 *  Never overwrites an existing drop.yaml. */
export async function migrateConfig(dir: string): Promise<{ written: string } | { skipped: string }> {
  const yamlPath = join(dir, CONFIG_FILE_YAML);
  if (await exists(yamlPath)) return { skipped: yamlPath };
  const cfg = parseSiteConfig(await readFile(join(dir, CONFIG_FILE_JSON), "utf8"));
  await writeFile(yamlPath, stringifyYaml({ site: cfg }), "utf8");
  return { written: yamlPath };
}
