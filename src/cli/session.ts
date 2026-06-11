import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface Session {
  apiBase: string;
  token: string;
}

export function defaultSessionPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "drop", "session.json");
}

export async function saveSession(path: string, s: Session): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export async function loadSession(path: string): Promise<Session> {
  return JSON.parse(await readFile(path, "utf8")) as Session;
}
