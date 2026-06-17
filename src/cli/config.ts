import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface CliConfig {
  apiBase?: string;
}

const DEFAULT_API = "https://api.drop.example.com";

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "drop", "config.json");
}

export async function loadConfig(path = defaultConfigPath()): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(cfg: CliConfig, path = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Resolve the control-plane URL: --api flag > DROP_API env > saved config > default. */
export async function resolveApiBase(opts: { api?: string }, path = defaultConfigPath()): Promise<string> {
  if (opts.api) return opts.api.replace(/\/$/, "");
  if (process.env.DROP_API) return process.env.DROP_API.replace(/\/$/, "");
  const cfg = await loadConfig(path);
  return (cfg.apiBase ?? DEFAULT_API).replace(/\/$/, "");
}
