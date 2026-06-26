import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve } from "node:path";
import { defaultSessionPath, loadSession, saveSession, type Session } from "../cli/session.ts";
import { Client } from "../cli/client.ts";
import { packDir } from "../cli/pack.ts";
import { devLoginToken, serverLogin } from "../cli/login.ts";
import { resolveSiteName, loadAppDeploy, loadDatabaseCreate } from "../cli/resolve-name.ts";

function apiBase(s?: Session): string {
  return process.env.DROP_API ?? s?.apiBase ?? "https://api.drop.example.com";
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
      inputSchema: { email: z.string().describe("your email, e.g. alice@example.com") },
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
      description: "Publish a built static folder to <name>.drop.example.com. Returns the live URL.",
      inputSchema: {
        directory: z.string().describe("path to the built folder, e.g. ./dist"),
        name: z.string().optional().describe("site name (optional — taken from drop.yaml site.name, else generated)"),
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
    "deploy",
    {
      description: "Deploy a container app from a folder's drop.yaml app: section to <name>.drop.example.com.",
      inputSchema: {
        directory: z.string().describe("path to the folder containing drop.yaml, e.g. ."),
        name: z.string().optional().describe("app name (optional — taken from drop.yaml app.name, else generated)"),
      },
    },
    async ({ directory, name }) =>
      run(async () => {
        const { name: resolved, source, app } = await loadAppDeploy(resolve(directory), name);
        const res = await (await getClient()).deploy(resolved, app);
        return { ...res, name: resolved, nameSource: source };
      }),
  );

  server.registerTool(
    "db_create",
    {
      description: "Create a managed Postgres database. Apps in the same owner's namespace connect via the returned host + the credentials Secret (the password is never returned).",
      inputSchema: {
        name: z.string().describe("database name (DNS-safe; databases are named explicitly, never generated)"),
        directory: z.string().optional().describe("folder whose drop.yaml database: section supplies storage/hibernation (defaults to none → server defaults)"),
      },
    },
    async ({ name, directory }) =>
      run(async () => {
        const db = await loadDatabaseCreate(directory ? resolve(directory) : ".");
        return await (await getClient()).dbCreate(name, db);
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
    async ({ name, email }) => run(() => getClient().then((c) => c.transfer(name, { email }))),
  );

  // ---- app secrets (write-only) + lifecycle ----
  server.registerTool(
    "secret_set",
    {
      description: "Set/rotate an app secret (owner only). Stored write-only and injected as an env var; the value is never readable again. Restart the app to apply.",
      inputSchema: { app: z.string(), key: z.string().describe("UPPER_SNAKE env-var name"), value: z.string() },
    },
    async ({ app, key, value }) => run(() => getClient().then((c) => c.setSecret(app, key, value))),
  );
  server.registerTool(
    "secret_list",
    { description: "List an app's secret KEY names + metadata (never the values).", inputSchema: { app: z.string() } },
    async ({ app }) => run(() => getClient().then((c) => c.listSecrets(app))),
  );
  server.registerTool(
    "secret_delete",
    { description: "Delete an app secret (owner only).", inputSchema: { app: z.string(), key: z.string() } },
    async ({ app, key }) => run(() => getClient().then((c) => c.deleteSecret(app, key))),
  );
  server.registerTool(
    "app_restart",
    { description: "Roll an app's pods (applies newly-set secrets/config).", inputSchema: { app: z.string() } },
    async ({ app }) => run(() => getClient().then((c) => c.restartApp(app))),
  );
  server.registerTool(
    "app_stop",
    { description: "Take an app offline (true stop — won't wake on traffic).", inputSchema: { app: z.string() } },
    async ({ app }) => run(() => getClient().then((c) => c.stopApp(app))),
  );
  server.registerTool(
    "app_start",
    { description: "Bring a stopped app back online.", inputSchema: { app: z.string() } },
    async ({ app }) => run(() => getClient().then((c) => c.startApp(app))),
  );

  // ---- organisations (group resources + org-level permissions) ----
  server.registerTool(
    "org_create",
    { description: "Create a team organisation (you become owner). Deploy into it with the `org` arg on deploy/db_create.", inputSchema: { slug: z.string(), name: z.string().optional() } },
    async ({ slug, name }) => run(() => getClient().then((c) => c.createOrg(slug, name))),
  );
  server.registerTool(
    "org_list",
    { description: "List the organisations you belong to + your role in each.", inputSchema: {} },
    async () => run(() => getClient().then((c) => c.listOrgs())),
  );
  server.registerTool(
    "org_add_member",
    { description: "Add/update an org member (role: owner|admin|member|viewer; default member). Owner/admin only.", inputSchema: { slug: z.string(), email: z.string(), role: z.string().optional() } },
    async ({ slug, email, role }) => run(() => getClient().then((c) => c.addOrgMember(slug, email, role))),
  );

  // ---- platform admin: users + roles ----
  server.registerTool(
    "admin_list_users",
    { description: "List all platform users with their role (admin|member) + status. Platform admins only.", inputSchema: {} },
    async () => run(() => getClient().then((c) => c.adminListUsers())),
  );
  server.registerTool(
    "admin_set_role",
    { description: "Grant/revoke the platform-admin role (role: admin|member). Platform admins only; you can't change your own role.", inputSchema: { email: z.string(), role: z.enum(["admin", "member"]) } },
    async ({ email, role }) => run(() => getClient().then((c) => c.adminSetRole(email, role))),
  );
  server.registerTool(
    "admin_audit",
    {
      description: "Read the append-only audit trail of mutating/admin actions (newest first). Platform admins only.",
      inputSchema: {
        actor: z.string().optional().describe("filter by who performed the action"),
        target: z.string().optional().describe("filter by the resource/user acted upon"),
        action: z.string().optional().describe("filter by action verb, e.g. site.delete"),
        limit: z.number().optional(),
      },
    },
    async ({ actor, target, action, limit }) => run(() => getClient().then((c) => c.adminAudit({ actor, target, action, limit }))),
  );

  return server;
}
