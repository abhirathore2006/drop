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
  // CI story (J1): a `DROP_TOKEN` env bearer (a `drop_st_…` service token) authenticates non-
  // interactively — no `drop login`, no session.json on disk. When set it WINS over any saved session,
  // so a CI job just exports DROP_API + DROP_TOKEN and runs `drop deploy`. The API URL resolves the usual
  // way (DROP_API env / saved config / default); `--api` isn't consulted on this path — set DROP_API.
  if (process.env.DROP_TOKEN) {
    return new Client({ apiBase: await resolveApiBase({}), token: process.env.DROP_TOKEN });
  }
  try {
    return new Client(await loadSession(defaultSessionPath()));
  } catch {
    console.error("not logged in — run `drop login` (or `drop dev-login`, or set DROP_TOKEN for CI) first");
    process.exit(1);
  }
}

const show = (v: unknown) => console.log(JSON.stringify(v, null, 2));

/** Parse a human token-expiry duration (`90d`, `12w`, `6mo`, `1y`, or a bare day count) → whole days. */
function parseExpiryDays(s: string): number {
  const m = /^(\d+)\s*(d|w|mo|m|y)?$/i.exec(s.trim());
  if (!m) throw new Error(`invalid --expires "${s}" — use e.g. 90d, 12w, 6mo, 1y`);
  const n = parseInt(m[1]!, 10);
  const unit = (m[2] ?? "d").toLowerCase();
  const mult = unit === "w" ? 7 : unit === "mo" || unit === "m" ? 30 : unit === "y" ? 365 : 1;
  const days = n * mult;
  if (days <= 0 || days > 3650) throw new Error("--expires out of range (1–3650 days)");
  return days;
}

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
  db
    .command("expose <name>")
    .description("Expose a managed database for direct psql (sugar for `drop expose <name> --sni --protocol postgres`)")
    .action(async (name: string) => {
      const res = (await (await client()).expose(name, { mode: "sni", protocol: "postgres" })) as {
        tcp: { mode: string; protocol: string; connect: string; sslmode?: string };
        note?: string;
      };
      console.log(`  ✓ ${name} exposed for direct psql (${res.tcp.mode}/${res.tcp.protocol})`);
      console.log(`     connect: ${res.tcp.connect}`);
      if (res.tcp.sslmode) console.log(`     ${res.tcp.sslmode}`);
      if (res.note) console.log(`     note: ${res.note}`);
    });

  // ---- buckets (tenant object storage, I1) ----
  const bucket = program.command("bucket").description("Manage object-storage buckets (create / ls / rotate / rm)");
  const printBucketCreds = (res: { name: string; endpoint: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string }) => {
    console.log(`  ✓ bucket ${res.name} ready`);
    console.log(`     endpoint: ${res.endpoint || "(AWS default)"}  bucket: ${res.bucket}  prefix: ${res.prefix}`);
    console.log(`  ✓ credentials — shown once, store them now (bind with \`uses: [{ bucket: ${res.name} }]\` to inject them automatically):`);
    console.log(`     S3_ACCESS_KEY_ID=${res.accessKeyId}`);
    console.log(`     S3_SECRET_ACCESS_KEY=${res.secretAccessKey}`);
  };
  bucket
    .command("create <name>")
    .description("Create a tenant object-storage bucket (credentials are printed once)")
    .option("--org <slug>", "create in this organisation (default: your personal org)")
    .action(async (name: string, opts: { org?: string }) => {
      const err = validateName(name);
      if (err) throw new Error(err);
      console.log(`  ▸ creating bucket ${name}…`);
      printBucketCreds(await (await client()).bucketCreate(name, opts.org));
    });
  bucket
    .command("ls")
    .description("List your buckets")
    .option("--org <slug>", "show only buckets in this organisation")
    .action(async (opts: { org?: string }) => show(await (await client()).bucketList(opts.org)));
  bucket
    .command("rotate <name>")
    .description("Re-mint a bucket's access credentials (owner only; printed once)")
    .action(async (name: string) => {
      const err = validateName(name);
      if (err) throw new Error(err);
      console.log(`  ▸ rotating credentials for ${name}…`);
      printBucketCreds(await (await client()).bucketRotate(name));
    });
  bucket
    .command("rm <name>")
    .description("Delete a bucket (use --force to delete a non-empty one and its contents)")
    .option("--force", "delete even when the bucket holds objects (wipes its contents)")
    .action(async (name: string, opts: { force?: boolean }) => show(await (await client()).bucketRemove(name, opts.force)));

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

  // ---- service accounts / scoped CI tokens (J1) ----
  const token = program.command("token").description("Manage service-account / CI tokens (scoped, org-owned bearer credentials)");
  token
    .command("create")
    .description("Mint a scoped CI token — the secret is printed ONCE, store it now (use as DROP_TOKEN in CI)")
    .requiredOption("--org <slug>", "the organisation that owns the token")
    .requiredOption("--scope <list>", "comma-separated scopes: <verb>[:<resource>|:*], e.g. deploy:myapp,publish:web")
    .option("--name <name>", "a human label (shows as the audit actor: token:<name>@<org>)", "ci")
    .option("--expires <dur>", "expiry, e.g. 90d / 12w / 6mo / 1y (default: never)")
    .action(async (opts: { org: string; scope: string; name: string; expires?: string }) => {
      const scopes = opts.scope.split(",").map((s) => s.trim()).filter(Boolean);
      if (!scopes.length) throw new Error("--scope must list at least one scope, e.g. deploy:myapp");
      const expiresDays = opts.expires ? parseExpiryDays(opts.expires) : undefined;
      const res = (await (await client()).createToken(opts.org, opts.name, scopes, expiresDays)) as {
        token: string; id: string; name: string; scopes: string[]; expiresAt: string | null;
      };
      console.log(`  ✓ token ${res.name} created (${res.id})`);
      console.log(`     scopes:  ${res.scopes.join(", ")}`);
      console.log(`     expires: ${res.expiresAt ?? "never"}`);
      console.log(`  ✓ secret — shown once, store it now (export it as DROP_TOKEN in CI):`);
      console.log(`     ${res.token}`);
    });
  token
    .command("ls")
    .description("List an org's tokens (name, scopes, last used, expiry, revoked state)")
    .requiredOption("--org <slug>", "the organisation")
    .action(async (opts: { org: string }) => show(await (await client()).listTokens(opts.org)));
  token
    .command("revoke <id>")
    .description("Revoke a token by id (immediate — the token stops authenticating)")
    .requiredOption("--org <slug>", "the organisation that owns the token")
    .action(async (id: string, opts: { org: string }) => show(await (await client()).revokeToken(opts.org, id)));

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

  // ---- TCP (L4) exposure (A2b) ----
  const printExpose = (name: string, res: { tcp: { mode: string; protocol: string; connect: string; sslmode?: string }; note?: string }) => {
    console.log(`  ✓ ${name} exposed (${res.tcp.mode}/${res.tcp.protocol})`);
    console.log(`     connect: ${res.tcp.connect}`);
    if (res.tcp.sslmode) console.log(`     ${res.tcp.sslmode}`);
    if (res.note) console.log(`     note: ${res.note}`);
  };
  const expose = program.command("expose").description("Expose a workload over the L4 (TCP) plane, or list your exposures");
  expose
    .command("ls")
    .description("List your TCP-exposed workloads + their connect strings")
    .option("--org <slug>", "show only exposures in this organisation")
    .action(async (opts: { org?: string }) => {
      const res = (await (await client()).exposeList(opts.org)) as {
        exposed: { name: string; type: string; mode: string; protocol: string; port: number | null; connect: string }[];
      };
      if (!res.exposed.length) {
        console.log("  no TCP-exposed workloads");
        return;
      }
      console.log("  NAME             TYPE       MODE   PROTOCOL   CONNECT");
      for (const e of res.exposed) {
        console.log(`  ${e.name.padEnd(16)} ${e.type.padEnd(10)} ${e.mode.padEnd(6)} ${e.protocol.padEnd(10)} ${e.connect}`);
      }
    });
  expose
    .command("set <name>", { isDefault: true })
    .description("Expose a workload: drop expose <name> [--sni|--port] [--protocol tcp|postgres|redis]")
    .option("--sni", "route by TLS SNI on a shared port — no dedicated port consumed (the default)")
    .option("--port", "allocate a dedicated port from the dynamic pool")
    .option("--protocol <p>", "tcp | postgres | redis (default: postgres for databases, tcp for apps)")
    .action(async (name: string, opts: { sni?: boolean; port?: boolean; protocol?: string }) => {
      if (opts.sni && opts.port) throw new Error("choose one of --sni or --port");
      const mode = opts.port ? "port" : "sni"; // default sni — scarce-port-frugal
      printExpose(name, await (await client()).expose(name, { mode, protocol: opts.protocol }));
    });
  program
    .command("unexpose <name>")
    .description("Remove a workload's TCP exposure")
    .action(async (name: string) => {
      await (await client()).unexpose(name);
      console.log(`  ✓ ${name} unexposed`);
    });

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
