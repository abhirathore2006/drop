import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface CliConfig {
  apiBase?: string;
  installUrl?: string; // where `drop update` re-fetches the CLI from (the install.sh URL); recorded by install.sh
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

/** Resolve the install.sh URL `drop update` re-runs: --api/<origin>/install.sh > recorded installUrl
 *  > apiBase/install.sh. Throws if none is known (CLI wasn't installed via install.sh and no --api).
 *  Only http(s) URLs are allowed — the result is fed to a shell installer. */
export function resolveUpdateUrl(cfg: CliConfig, opts: { api?: string } = {}): string {
  let url: string | undefined;
  if (opts.api) url = `${opts.api.replace(/\/+$/, "")}/install.sh`;
  else if (cfg.installUrl) url = cfg.installUrl;
  else if (cfg.apiBase) url = `${cfg.apiBase.replace(/\/+$/, "")}/install.sh`;
  if (!url) throw new Error("no install source recorded — install/update with:  curl -fsSL <API>/install.sh | sh  (or pass --api <url>)");
  if (!/^https?:\/\//.test(url)) throw new Error(`refusing to update from a non-http(s) URL: ${url}`);
  return url;
}
