import { Command } from "commander";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { defaultSessionPath, loadSession, saveSession } from "./session.ts";
import { loadConfig, saveConfig, resolveApiBase, resolveUpdateUrl } from "./config.ts";
import { Client } from "./client.ts";
import { packDir } from "./pack.ts";
import { devLoginToken, serverLogin } from "./login.ts";
import { resolveSiteName, loadAppDeploy, loadDatabaseCreate } from "./resolve-name.ts";
import { buildAndPushImage } from "./build-push.ts";
import { runStackUp } from "./stack.ts";
import { validateName } from "../names.ts";
import { VERSION } from "../version.ts";

async function client(): Promise<Client> {
  try {
    return new Client(await loadSession(defaultSessionPath()));
  } catch {
    console.error("not logged in — run `drop login` (or `drop dev-login`) first");
    process.exit(1);
  }
}

const show = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Ask the instance which CLI version it serves (so `update` can show current → target). Best-effort. */
async function fetchServerVersion(installUrl: string): Promise<string | null> {
  try {
    const origin = installUrl.replace(/\/install\.sh$/, "");
    const res = await fetch(`${origin}/version`);
    if (!res.ok) return null;
    const j = (await res.json()) as { version?: unknown };
    return typeof j.version === "string" ? j.version : null;
  } catch {
    return null;
  }
}

/** Re-run the installer: fetch install.sh (curl or wget) and pipe it to sh. The URL is passed as a
 *  positional ($1) — never interpolated into the command string — and is validated http(s) upstream. */
function runInstaller(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("sh", ["-c", 'if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi | sh', "sh", url], { stdio: "inherit" });
    p.on("error", (e) => reject(new Error(`update failed to start (need sh + curl or wget): ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`update failed (installer exited ${code})`))));
  });
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("drop").description("Publish static sites to *.drop.example.com");
  program.version(VERSION, "-v, --version", "print the drop CLI version");
  program.option("--api <url>", "control plane base URL");

  // Set the control-plane URL once, so you don't pass --api on every command.
  const config = program.command("config").description("Manage CLI config");
  config
    .command("set-api <url>")
    .description("Persist the control-plane API URL (used when --api / DROP_API are unset)")
    .action(async (url: string) => {
      const cfg = await loadConfig();
      cfg.apiBase = url.replace(/\/$/, "");
      await saveConfig(cfg);
      console.log(`✓ API URL set to ${cfg.apiBase}`);
    });
  config
    .command("show")
    .description("Show the saved config and the resolved API URL")
    .action(async () => {
      show({ configured: await loadConfig(), resolvedApi: await resolveApiBase(program.opts()) });
    });

  // Update the CLI itself — re-runs the installer recorded in config at install time (installUrl),
  // which re-fetches the latest CLI bundle this instance serves. Override the source with --api.
  program
    .command("update")
    .description("Update the drop CLI to the latest version (re-runs the installer from where it was installed)")
    .option("--force", "re-install even if already on the latest version")
    .action(async (opts: { force?: boolean }) => {
      const url = resolveUpdateUrl(await loadConfig(), { api: program.opts().api });
      const target = await fetchServerVersion(url);
      console.log(`  current version:  ${VERSION}`);
      console.log(`  update to:        ${target ?? "(latest — the server didn't report a version)"}`);
      if (target && target === VERSION && !opts.force) {
        console.log(`  ✓ already up to date — nothing to do (use --force to re-install)`);
        return;
      }
      console.log(`  ▸ updating from ${url} …`);
      await runInstaller(url);
      console.log(`  ✓ drop updated — re-run your command to pick up the new version`);
    });

  program
    .command("login")
    .description("Sign in with Google (via the Drop server)")
    .action(async () => {
      const base = await resolveApiBase(program.opts());
      const token = await serverLogin(base);
      await saveSession(defaultSessionPath(), { apiBase: base, token });
      console.log("✓ logged in");
    });

  program
    .command("dev-login <sub> <email>")
    .description("Local-only login (requires DROP_DEV_AUTH=1 on the API)")
    .action(async (sub: string, email: string) => {
      const base = await resolveApiBase(program.opts());
      await saveSession(defaultSessionPath(), { apiBase: base, token: devLoginToken(sub, email) });
      console.log(`✓ dev session saved (${base})`);
    });

  program
    .command("logout")
    .description("Clear the saved session")
    .action(async () => {
      await rm(defaultSessionPath(), { force: true });
      console.log("✓ logged out");
    });

  program
    .command("publish <dir> [name]")
    .description("Publish a built folder (name optional — taken from drop.yaml, else generated)")
    .option("--org <slug>", "create in this organisation (default: your personal org)")
    .action(async (dir: string, nameArg: string | undefined, opts: { org?: string }) => {
      const { name, source } = await resolveSiteName(dir, nameArg);
      console.log(`  ▸ packing ${dir}`);
      const tarball = await packDir(dir);
      console.log(`  ▸ dropping to ${name}…`);
      const res = await (await client()).publish(name, tarball, opts.org);
      console.log(`  ✓ live at ${res.url}`);
      if (source === "generated") {
        console.log(`  tip: add  name: ${name}  under site: in drop.yaml to keep this URL across deploys.`);
      }
    });

  program
    .command("deploy <dir> [name]")
    .description("Deploy a container app (reads the app: section from drop.yaml)")
    .option("--org <slug>", "create in this organisation (default: your personal org)")
    .option("--build", "build the image from dir's Dockerfile and push it through Drop (no registry needed)")
    .option("-f, --dockerfile <path>", "build from a specific Dockerfile (e.g. Dockerfile.prod); implies --build")
    .option("--no-start", "deploy without starting the pod (set secrets/config first, then `drop start <app>`) — avoids a broken first boot")
    .action(async (dir: string, nameArg: string | undefined, opts: { org?: string; build?: boolean; dockerfile?: string; start?: boolean }) => {
      const { name, source, app } = await loadAppDeploy(dir, nameArg);
      if (opts.build || opts.dockerfile) {
        const { image } = await buildAndPushImage(await client(), dir, name, { org: opts.org, dockerfile: opts.dockerfile });
        app.image = image; // deploy the just-pushed image instead of the drop.yaml ref
      }
      // commander maps `--no-start` to opts.start === false
      const noStart = opts.start === false;
      console.log(`  ▸ deploying ${name}  (${app.image})${noStart ? " — not starting yet" : ""}…`);
      const res = await (await client()).deploy(name, app, opts.org, noStart);
      if (res.started === false) {
        console.log(`  ✓ deployed ${name} (stopped). Set its secrets/config, then start it:`);
        console.log(`      drop start ${name}`);
      } else {
        console.log(`  ✓ live at ${res.url}`);
      }
      if (source === "generated") {
        console.log(`  tip: add  name: ${name}  under app: in drop.yaml to keep this URL across deploys.`);
      }
    });

  program
    .command("push <dir> [name]")
    .description("Build the app image from dir's Dockerfile and push it through Drop (no registry needed); prints the in-cluster ref")
    .option("--org <slug>", "target organisation (default: your personal org)")
    .option("-f, --dockerfile <path>", "build from a specific Dockerfile (e.g. Dockerfile.prod)")
    .action(async (dir: string, nameArg: string | undefined, opts: { org?: string; dockerfile?: string }) => {
      const { name } = await loadAppDeploy(dir, nameArg);
      const { image } = await buildAndPushImage(await client(), dir, name, { org: opts.org, dockerfile: opts.dockerfile });
      console.log(`  ✓ pushed ${image}`);
      console.log(`  tip: prefer  drop deploy ${dir} --build  (build+push+deploy in one step — a fresh tag each build, so redeploys roll the pods).`);
      console.log(`       if you instead pin  image: ${image}  in drop.yaml, bump the tag on a rebuild — reusing the same tag won't roll the pods.`);
    });

  // ---- stacks (B2): declarative multi-resource `drop up` ----
  program
    .command("up [dir]")
    .description("Reconcile the stack: section of drop.yaml (creates DBs/apps/sites + wires their edges)")
    .option("--org <slug>", "create in this organisation (default: your personal org)")
    .option("--dry-run", "print the plan without applying it")
    .option("--prune", "delete resources removed from the spec (default: they are only flagged)")
    .action(async (dir: string | undefined, opts: { org?: string; dryRun?: boolean; prune?: boolean }) => {
      const c = await client();
      const res = await runStackUp(c, dir ?? ".", { org: opts.org, dryRun: opts.dryRun, prune: opts.prune, log: (s) => console.log(s) });
      if (res.dryRun) {
        console.log("  (dry run — nothing applied)");
        return;
      }
      console.log(`  ✓ stack ${res.result!.stack} reconciled (spec v${res.result!.specVersion})`);
    });

  const stack = program.command("stack").description("Manage stacks (declarative multi-resource groups)");
  stack
    .command("ls")
    .description("List your stacks")
    .option("--org <slug>", "show only stacks in this organisation")
    .action(async (opts: { org?: string }) => show(await (await client()).stackList(opts.org)));
  stack
    .command("status <name>")
    .description("Show a stack's spec + its resources' live status")
    .option("--org <slug>", "the stack's organisation (disambiguates a name across orgs)")
    .action(async (name: string, opts: { org?: string }) => show(await (await client()).stackGet(name, opts.org)));
  stack
    .command("rm <name>")
    .description("Delete a stack; --cascade also tears down its resources (else they are orphaned)")
    .option("--org <slug>", "the stack's organisation")
    .option("--cascade", "also delete the stack's resources (destructive)")
    .action(async (name: string, opts: { org?: string; cascade?: boolean }) => show(await (await client()).stackDelete(name, { org: opts.org, cascade: opts.cascade })));

  const db = program.command("db").description("Manage managed Postgres databases (create / password)");
  db
    .command("create <name> [dir]")
    .description("Create a managed Postgres database (reads the database: section from dir/drop.yaml if present)")
    .option("--org <slug>", "create in this organisation (default: your personal org)")
    .action(async (name: string, dir: string | undefined, opts: { org?: string }) => {
      const err = validateName(name);
      if (err) throw new Error(err);
      const cfg = await loadDatabaseCreate(dir ?? ".");
      console.log(`  ▸ creating database ${name}…`);
      const res = await (await client()).dbCreate(name, cfg, opts.org);
      console.log(`  ✓ ${res.engine} ready`);
      console.log(`     host: ${res.host}:${res.port}  db: ${res.database}  user: ${res.user}`);
      console.log(`     credentials: read Secret '${res.credentialsSecret}' (keys username/password) in your app's namespace (envFrom) — the password is never printed.`);
    });
  db
    .command("password <name> [password]")
    .description("Set/rotate the managed database's `app` password (owner only; generates one if omitted)")
    .option("--password-stdin", "read the new password from stdin (avoids shell history / process listing)")
    .option(
      "--set-secret <app:KEY>",
      "rotate + store the new password DIRECTLY as app <app>'s write-only secret <KEY> (e.g. blog:PGPASSWORD) — never printed, never touches your terminal",
    )
    .option("--show", "also print the password (use with --set-secret; without it the password is always printed)")
    .action(async (name: string, password: string | undefined, opts: { passwordStdin?: boolean; setSecret?: string; show?: boolean }) => {
      const err = validateName(name);
      if (err) throw new Error(err);
      let pw = password;
      if (opts.passwordStdin) {
        pw = (await readStdin()).trim();
        if (!pw) throw new Error("--password-stdin given but stdin was empty");
      } else if (password) {
        console.error("  ⚠ a password passed as an argument is saved to your shell history and visible in process listings — prefer --password-stdin, or omit it to generate a strong one.");
      }
      let setSecret: { app: string; key: string } | undefined;
      if (opts.setSecret) {
        const i = opts.setSecret.indexOf(":");
        const app = i > 0 ? opts.setSecret.slice(0, i) : "";
        const key = i > 0 ? opts.setSecret.slice(i + 1) : "";
        if (!app || !key) throw new Error("--set-secret must be <app>:<KEY>, e.g. blog:PGPASSWORD");
        setSecret = { app, key };
      }
      console.log(`  ▸ rotating password for ${name}…`);
      const res = await (await client()).dbPassword(name, pw, setSecret, opts.show);
      if (res.secretSet) {
        console.log(`  ✓ rotated + stored as secret ${res.secretSet.key} on ${res.secretSet.app} (${res.secretSet.fingerprint}) — not printed`);
        if (res.password) console.log(`     ${res.password}`); // only when --show
        console.log(`     ${res.note ?? `start/restart ${res.secretSet.app} to apply`}`);
      } else {
        console.log(`  ✓ password set for user '${res.user}' — shown once, store it now:`);
        console.log(`     ${res.password}`);
      }
      if (res.warning) console.error(`  ⚠ ${res.warning}`);
    });

  db
    .command("backups <name>")
    .description("List a managed database's backups + the last successful one")
    .action(async (name: string) => show(await (await client()).dbBackups(name)));
  db
    .command("backup <name>")
    .description("Trigger an on-demand backup now (editor+)")
    .action(async (name: string) => {
      const res = await (await client()).dbBackup(name);
      console.log(`  ✓ backup ${res.backup} started for ${res.name}`);
    });
  db
    .command("hibernate <name>")
    .description("Hibernate a managed database (scale to zero; editor+)")
    .action(async (name: string) => {
      await (await client()).dbHibernate(name);
      console.log(`  ✓ ${name} hibernated — wake it with: drop db wake ${name}`);
    });
  db
    .command("wake <name>")
    .description("Wake a hibernated database")
    .action(async (name: string) => {
      await (await client()).dbWake(name);
      console.log(`  ✓ ${name} waking`);
    });

  const org = program.command("org").description("Manage organisations (group resources + org-level permissions)");
  org
    .command("create <slug> [name]")
    .description("Create a team organisation (you become owner). Deploy into it with --org <slug>.")
    .action(async (slug: string, name?: string) => show(await (await client()).createOrg(slug, name)));
  org.command("ls").description("List your organisations + your role in each").action(async () => show(await (await client()).listOrgs()));
  org.command("members <slug>").description("Show an org's members").action(async (slug: string) => show(await (await client()).orgInfo(slug)));
  org
    .command("usage <slug>")
    .description("Show an org's workload counts (vs the cap) + live cluster quota consumption")
    .action(async (slug: string) => show(await (await client()).orgUsage(slug)));
  org
    .command("add <slug> <email> [role]")
    .description("Add/update a member (owner|admin|member|viewer; default member)")
    .action(async (slug: string, email: string, role?: string) => show(await (await client()).addOrgMember(slug, email, role)));
  org.command("rm <slug> <email>").description("Remove a member").action(async (slug: string, email: string) => show(await (await client()).removeOrgMember(slug, email)));

  const secrets = program.command("secrets").description("Manage an app's write-only secrets (set/list-keys/delete; values are never shown)");
  secrets
    .command("set <app> <key> [value]")
    .description("Set/rotate a secret. Value via stdin if omitted (recommended); restart the app to apply.")
    .option("--stdin", "read the value from stdin")
    .action(async (appName: string, key: string, value: string | undefined, opts: { stdin?: boolean }) => {
      let v = value;
      if (opts.stdin || value === undefined) v = (await readStdin()).replace(/\n$/, "");
      else console.error("  ⚠ a secret value passed as an argument is saved to your shell history — prefer piping it via --stdin.");
      if (!v) throw new Error("value required (pass an argument, or pipe it in with --stdin)");
      const res = await (await client()).setSecret(appName, key, v);
      console.log(`  ✓ secret ${res.key} set (${res.fingerprint}) — not shown. apply it with:  drop restart ${appName}`);
    });
  secrets
    .command("ls <app>")
    .description("List an app's secret keys (names + metadata only)")
    .action(async (appName: string) => show(await (await client()).listSecrets(appName)));
  secrets
    .command("rm <app> <key>")
    .description("Delete a secret")
    .action(async (appName: string, key: string) => show(await (await client()).deleteSecret(appName, key)));

  program
    .command("restart <app>")
    .description("Roll the app's pods (applies newly-set secrets/config)")
    .action(async (appName: string) => show(await (await client()).restartApp(appName)));
  program
    .command("stop <app>")
    .description("Take the app offline (true stop — won't wake on traffic)")
    .action(async (appName: string) => show(await (await client()).stopApp(appName)));
  program
    .command("start <app>")
    .description("Bring a stopped app back online")
    .action(async (appName: string) => show(await (await client()).startApp(appName)));

  program
    .command("ps <app>")
    .description("Show an app's processes (web + workers): ready/replicas, restarts, state")
    .action(async (appName: string) => {
      const res = (await (await client()).processes(appName)) as {
        processes: { name: string; process: string; web: boolean; ready: number; replicas: number; restarts: number; reason: string }[];
      };
      if (!res.processes.length) {
        console.log("  no processes running (app not deployed, or compute is off)");
        return;
      }
      console.log("  PROCESS   READY   RESTARTS   STATE");
      for (const p of res.processes) {
        const role = p.web ? "web" : p.process;
        console.log(`  ${role.padEnd(9)} ${`${p.ready}/${p.replicas}`.padEnd(7)} ${String(p.restarts).padEnd(10)} ${p.reason}`);
      }
    });

  program
    .command("logs <name>")
    .description("Show recent logs for an app/database (--release reads the latest release Job's pod)")
    .option("--tail <n>", "number of lines (default 100, max 1000)", (v) => parseInt(v, 10))
    .option("--release", "read the latest release (migration) Job's logs instead of the app pods")
    .option("-f, --follow", "stream new log lines as they arrive (Ctrl-C to stop)")
    .action(async (name: string, opts: { tail?: number; release?: boolean; follow?: boolean }) => {
      if (opts.follow) {
        if (opts.release) {
          console.error("--follow cannot be combined with --release (a release Job runs once and exits)");
          process.exitCode = 1;
          return;
        }
        const controller = new AbortController();
        process.once("SIGINT", () => controller.abort());
        const res = await (await client()).logsFollow(name, { tail: opts.tail, signal: controller.signal });
        const body = res.body;
        if (!body) return;
        const reader = body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            process.stdout.write(decoder.decode(value, { stream: true }));
          }
        } catch (e) {
          if (!controller.signal.aborted) throw e; // Ctrl-C aborting the fetch is expected, not an error
        }
        return;
      }
      const res = (await (await client()).logs(name, { tail: opts.tail, release: opts.release })) as { logs: string };
      process.stdout.write(res.logs.endsWith("\n") || res.logs === "" ? res.logs : res.logs + "\n");
    });

  program
    .command("rollback <name>")
    .description("Roll back to the previous (or --to) version")
    .option("--to <version>", "specific version id")
    .action(async (name: string, opts: { to?: string }) => {
      const res = await (await client()).rollback(name, opts.to ?? "");
      console.log(`  ✓ now serving ${res.version} at ${res.url}`);
    });

  program.command("info <name>").description("Show site metadata").action(async (name: string) => show(await (await client()).info(name)));
  program.command("members <name>").description("Show owner + collaborators").action(async (name: string) => show(await (await client()).info(name)));
  program
    .command("ls")
    .description("List your workloads (sites, apps, databases)")
    .option("--org <slug>", "show only resources in this organisation")
    .action(async (opts: { org?: string }) => show(await (await client()).list(opts.org)));
  program.command("rm <name>").description("Unpublish a site").action(async (name: string) => show(await (await client()).remove(name)));
  program.command("share <name> <email>").description("Add a collaborator").action(async (name: string, email: string) => show(await (await client()).share(name, email)));
  program.command("unshare <name> <email>").description("Remove a collaborator").action(async (name: string, email: string) => show(await (await client()).unshare(name, email)));
  program
    .command("transfer <name> [email]")
    .description("Transfer a resource to a USER (their personal org), or move it into a TEAM org with --org")
    .option("--org <slug>", "move the resource into this team org (instead of transferring to a user)")
    .action(async (name: string, email: string | undefined, opts: { org?: string }) => {
      if (!email && !opts.org) throw new Error("specify a target: an <email> (transfer to a user) or --org <slug> (move into a team org)");
      if (email && opts.org) throw new Error("specify either an <email> or --org, not both");
      show(await (await client()).transfer(name, email ? { email } : { toOrg: opts.org }));
    });

  const admin = program.command("admin").description("Platform-admin operations (admins only): manage users + roles");
  admin
    .command("users")
    .description("List all users with their platform role + status")
    .action(async () => show(await (await client()).adminListUsers()));
  admin
    .command("set-role <email> <role>")
    .description("Grant/revoke the platform-admin role (role: admin|member) — no reboot, replaces editing DROP_ADMINS")
    .action(async (email: string, role: string) => {
      if (role !== "admin" && role !== "member") throw new Error("role must be admin|member");
      show(await (await client()).adminSetRole(email, role));
    });
  admin
    .command("suspend <email>")
    .description("Suspend a user (denies all access)")
    .action(async (email: string) => show(await (await client()).adminSetStatus(email, "suspended")));
  admin
    .command("reactivate <email>")
    .description("Reactivate a suspended user")
    .action(async (email: string) => show(await (await client()).adminSetStatus(email, "active")));
  admin
    .command("audit")
    .description("Read the append-only audit trail of mutating/admin actions (newest first)")
    .option("--actor <email>", "filter by who performed the action")
    .option("--target <name>", "filter by the resource/user acted upon")
    .option("--action <verb>", "filter by action, e.g. site.delete")
    .option("--limit <n>", "max rows (default 100)", (v) => Number(v))
    .option("--cursor <id>", "keyset cursor from a previous page's nextCursor")
    .action(async (opts: { actor?: string; target?: string; action?: string; limit?: number; cursor?: string }) =>
      show(await (await client()).adminAudit(opts)),
    );

  return program;
}
