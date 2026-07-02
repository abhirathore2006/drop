import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDropYaml, CONFIG_FILE_YAML } from "../site-config.ts";
import { parseAppConfig, type AppConfig } from "../app-config.ts";
import { parseDatabaseConfig, type DatabaseConfig } from "../db-config.ts";
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

/**
 * Load a container-app deploy from a folder's drop.yaml `app:` section and resolve
 * its name (arg > app.name > generated). Throws if there is no valid app: section.
 */
export async function loadAppDeploy(
  dir: string,
  argName?: string,
): Promise<{ name: string; source: NameSource; app: AppConfig }> {
  let text: string;
  try {
    text = await readFile(join(dir, CONFIG_FILE_YAML), "utf8");
  } catch {
    throw new Error(`no ${CONFIG_FILE_YAML} found in ${dir}`);
  }
  const app = parseAppConfig(text);
  if (!app) throw new Error(`${CONFIG_FILE_YAML} has no valid app: section (image is required)`);
  if (argName) {
    const err = validateName(argName);
    if (err) throw new Error(err);
    return { name: argName, source: "arg", app };
  }
  if (app.name) return { name: app.name, source: "drop.yaml", app };
  return { name: generateName(), source: "generated", app };
}

/**
 * Load a database's config from a folder's drop.yaml `database:` section (storage,
 * hibernation, …). Databases are named explicitly (no generated names — they're
 * stateful), so the name is always the caller's argument. Returns an empty config
 * (server applies defaults) when there's no drop.yaml or no database: section.
 */
export async function loadDatabaseCreate(dir: string): Promise<DatabaseConfig | Record<string, never>> {
  let text: string;
  try {
    text = await readFile(join(dir, CONFIG_FILE_YAML), "utf8");
  } catch {
    return {}; // no drop.yaml → server defaults (postgres-18, 1Gi, no hibernation)
  }
  // A parse / validation error (e.g. storage over the per-database cap) must PROPAGATE — not be
  // swallowed like a missing file — so the CLI/MCP reject it up front with a clear message.
  return parseDatabaseConfig(text) ?? {};
}
