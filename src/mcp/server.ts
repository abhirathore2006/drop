import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve } from "node:path";
import { defaultSessionPath, loadSession, saveSession, type Session } from "../cli/session.ts";
import { Client } from "../cli/client.ts";
import { packDir } from "../cli/pack.ts";
import { devLoginToken, serverLogin } from "../cli/login.ts";
import { resolveSiteName } from "../cli/resolve-name.ts";

function apiBase(s?: Session): string {
  return process.env.DROP_API ?? s?.apiBase ?? "https://api.drop.company.com";
}

async function getClient(): Promise<Client> {
  let s: Session;
  try {
    s = await loadSession(defaultSessionPath());
  } catch {
    throw new Error("not logged in — run the `login` (or `dev_login`) tool first");
  }
  return new Client({ apiBase: apiBase(s), token: s.token });
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

// run wraps a client call with uniform error handling.
async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
}

export function buildMcp(): McpServer {
  const server = new McpServer({ name: "drop", version: "0.1.0" });

  server.registerTool(
    "login",
    { description: "Sign in to Drop with Google (opens a browser via the Drop server).", inputSchema: {} },
    async () => {
      try {
        const token = await serverLogin(apiBase());
        await saveSession(defaultSessionPath(), { apiBase: apiBase(), token });
        return ok("✓ logged in");
      } catch (e) {
        return fail(`login failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "dev_login",
    {
      description: "Local-only login (requires DROP_DEV_AUTH=1 on the API).",
      inputSchema: { email: z.string().describe("your email, e.g. alice@paytm.com") },
    },
    async ({ email }) => {
      const sub = email.split("@")[0] ?? email;
      await saveSession(defaultSessionPath(), { apiBase: apiBase(), token: devLoginToken(sub, email) });
      return ok(`✓ dev session saved for ${email}`);
    },
  );

  server.registerTool(
    "publish",
    {
      description: "Publish a built static folder to <name>.drop.company.com. Returns the live URL.",
      inputSchema: {
        directory: z.string().describe("path to the built folder, e.g. ./dist"),
        name: z.string().optional().describe("site name (optional — taken from _drop.json, else generated)"),
      },
    },
    async ({ directory, name }) =>
      run(async () => {
        const dir = resolve(directory);
        const resolved = await resolveSiteName(dir, name);
        const tarball = await packDir(dir);
        const res = await (await getClient()).publish(resolved.name, tarball);
        return { ...res, name: resolved.name, nameSource: resolved.source };
      }),
  );

  server.registerTool(
    "list_sites",
    { description: "List sites you own or collaborate on.", inputSchema: {} },
    async () => run(() => getClient().then((c) => c.list())),
  );

  server.registerTool(
    "site_info",
    { description: "Show a site's owner, collaborators, current version, and history.", inputSchema: { name: z.string() } },
    async ({ name }) => run(() => getClient().then((c) => c.info(name))),
  );

  server.registerTool(
    "rollback",
    {
      description: "Roll a site back to its previous (or a specific) version.",
      inputSchema: { name: z.string(), version: z.string().optional().describe("version id; omit for previous") },
    },
    async ({ name, version }) => run(() => getClient().then((c) => c.rollback(name, version ?? ""))),
  );

  server.registerTool(
    "delete_site",
    { description: "Unpublish a site (owner only).", inputSchema: { name: z.string() } },
    async ({ name }) => run(() => getClient().then((c) => c.remove(name))),
  );

  server.registerTool(
    "add_collaborator",
    { description: "Grant another user publish access (owner only).", inputSchema: { name: z.string(), email: z.string() } },
    async ({ name, email }) => run(() => getClient().then((c) => c.share(name, email))),
  );

  server.registerTool(
    "remove_collaborator",
    { description: "Revoke a collaborator (owner only).", inputSchema: { name: z.string(), email: z.string() } },
    async ({ name, email }) => run(() => getClient().then((c) => c.unshare(name, email))),
  );

  server.registerTool(
    "transfer_site",
    { description: "Transfer ownership to another user (owner only).", inputSchema: { name: z.string(), email: z.string() } },
    async ({ name, email }) => run(() => getClient().then((c) => c.transfer(name, email))),
  );

  return server;
}
