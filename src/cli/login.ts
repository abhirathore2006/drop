import { spawn } from "node:child_process";

export function devLoginToken(sub: string, email: string): string {
  return `${sub}:${email}`;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.unref();
  } catch {
    /* user can copy the URL */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Server-mediated login: ask the Drop API to start a Google login, open the
 * returned URL, then poll the API until it hands back a Drop session token.
 * The client needs only the API base URL — no Google credentials. Shared by the
 * CLI (`drop login`) and the MCP `login` tool.
 */
export async function serverLogin(apiBase: string): Promise<string> {
  const startRes = await fetch(`${apiBase}/auth/start`, { method: "POST" });
  const start = (await startRes.json().catch(() => ({}))) as { authUrl?: string; handle?: string; pollToken?: string; error?: string };
  if (!startRes.ok || !start.authUrl) {
    throw new Error(start.error ?? `login could not start (${startRes.status})`);
  }
  console.log(`\nOpening your browser to sign in with Google…\nIf it doesn't open, visit:\n  ${start.authUrl}\n`);
  openBrowser(start.authUrl);

  const deadline = Date.now() + 5 * 60 * 1000; // 5 min
  while (Date.now() < deadline) {
    await sleep(1500);
    const r = await fetch(`${apiBase}/auth/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: start.handle, pollToken: start.pollToken }),
    });
    const j = (await r.json().catch(() => ({}))) as { token?: string; status?: string; error?: string };
    if (j.token) return j.token;
    if (j.status === "denied") throw new Error(j.error ?? "login denied");
    if (j.status === "expired") throw new Error("login session expired — try again");
    // pending → keep polling
  }
  throw new Error("login timed out");
}
