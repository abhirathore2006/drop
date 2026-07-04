import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { rm, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { defaultSessionPath, loadSession, saveSession, type Session } from "./session.ts";
import { loadConfig, saveConfig, resolveApiBase, resolveUpdateUrl } from "./config.ts";
import { Client } from "./client.ts";
import { runDbProxy } from "./db-proxy.ts";
import { packDir } from "./pack.ts";
import { devLoginToken, serverLogin } from "./login.ts";
import { resolveSiteName, loadAppDeploy, loadDatabaseCreate, loadCacheCreate } from "./resolve-name.ts";
import { buildAndPushImage } from "./build-push.ts";
import { runStackUp } from "./stack.ts";
import { runDetect, serializeDetectedStack, writeDetectedStack } from "./detect.ts";
import { parseStackConfig } from "../stack-config.ts";
import { CONFIG_FILE_YAML } from "../site-config.ts";
import { validateName } from "../names.ts";
import { VERSION } from "../version.ts";

async function session(): Promise<Session> {
  // CI story (J1): a `DROP_TOKEN` env bearer (a `drop_st_…` service token) authenticates non-
  // interactively — no `drop login`, no session.json on disk. When set it WINS over any saved session,
  // so a CI job just exports DROP_API + DROP_TOKEN and runs `drop deploy`. The API URL resolves the usual
  // way (DROP_API env / saved config / default); `--api` isn't consulted on this path — set DROP_API.
  if (process.env.DROP_TOKEN) {
    return { apiBase: await resolveApiBase({}), token: process.env.DROP_TOKEN };
  }
  try {
    return await loadSession(defaultSessionPath());
  } catch {
    console.error("not logged in — run `drop login` (or `drop dev-login`, or set DROP_TOKEN for CI) first");
    process.exit(1);
  }
}

async function client(): Promise<Client> {
  return new Client(await session());
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

/** Commander collector for repeatable options (`--var a --var b` → ["a","b"]). */
const collect = (v: string, acc: string[]): string[] => (acc.push(v), acc);

/** A short, DNS-safe, collision-resistant preview label when the user doesn't name one: "pr-3f9a2b". */
function randomPreviewLabel(): string {
  return `pr-${randomBytes(3).toString("hex")}`;
}

interface TemplateVarSpec { key: string; description?: string; default?: string; required: boolean; secret?: boolean }
/** Parse a `--var key:description:default` declaration (the default may itself contain colons). */
function parseVarSpec(s: string, required: Set<string>, secret: Set<string>): TemplateVarSpec {
  const [key, desc, ...rest] = s.split(":");
  const v: TemplateVarSpec = { key: (key ?? "").trim(), required: required.has((key ?? "").trim()) };
  if (desc && desc.length) v.description = desc;
  const def = rest.join(":");
  if (def.length) v.default = def;
  if (secret.has(v.key)) v.secret = true;
  return v;
}

/** Parse `--set k=v` pairs into a values map (first `=` splits). */
function parseSets(sets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sets) {
    const i = s.indexOf("=");
    if (i < 0) throw new Error(`invalid --set "${s}" — use key=value`);
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

/** Prompt (TTY only) for any required variable still missing a value; `--set` values always win. */
async function promptMissingVars(
  variables: TemplateVarSpec[],
  values: Record<string, string>,
): Promise<Record<string, string>> {
  const missing = variables.filter((v) => v.required && !(v.key in values) && v.default == null);
  if (missing.length === 0) return values;
  if (!process.stdin.isTTY) {
    throw new Error(`missing required variable(s): ${missing.map((v) => v.key).join(", ")} — pass them with --set key=value`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const v of missing) {
      const label = `${v.key}${v.description ? ` (${v.description})` : ""}${v.secret ? " [secret]" : ""}: `;
      const answer = (await rl.question(label)).trim();
      if (answer.length) values[v.key] = answer;
    }
  } finally {
    rl.close();
  }
  return values;
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
    .option("--preview [label]", "publish as a PREVIEW at <name>--<label> (leaves the live site untouched); label defaults to a short random suffix")
    .option("--expire-days <n>", "preview expiry in days, 1-30 (default 7); only with --preview", (v) => parseInt(v, 10))
    .action(async (dir: string, nameArg: string | undefined, opts: { org?: string; preview?: string | boolean; expireDays?: number }) => {
      const { name, source } = await resolveSiteName(dir, nameArg);
      console.log(`  ▸ packing ${dir}`);
      const tarball = await packDir(dir);
      // Commander's `[label]` (optional-value option) gives `true` for a bare `--preview`.
      const preview = opts.preview === undefined ? undefined : { label: typeof opts.preview === "string" ? opts.preview : randomPreviewLabel(), expireDays: opts.expireDays };
      console.log(`  ▸ dropping to ${name}${preview ? ` (preview: ${preview.label})` : ""}…`);
      const res = await (await client()).publish(name, tarball, opts.org, preview);
      if (res.preview) {
        console.log(`  ✓ preview live at ${res.preview.url}  (expires ${res.preview.expiresAt})`);
      } else {
        console.log(`  ✓ live at ${res.url}`);
      }
      if (source === "generated") {
        console.log(`  tip: add  name: ${name}  under site: in drop.yaml to keep this URL across deploys.`);
      }
    });

  // ---- previews (E1): labeled, expiring extra versions served at <name>--<label> ----
  const previewCmd = program.command("preview").description("Manage static-site previews (drop publish --preview creates one)");
  previewCmd
    .command("ls <name>")
    .description("List a site's active previews")
    .action(async (name: string) => show(await (await client()).previewList(name)));
  previewCmd
    .command("rm <name> <label>")
    .description("Remove a preview (audited)")
    .action(async (name: string, label: string) => show(await (await client()).previewRemove(name, label)));

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

  // ---- repo detection (F1): propose a stack: section from local heuristics — no server call ----
  program
    .command("detect [dir]")
    .description("Propose a stack: section from local heuristics (Dockerfile/package.json/.env.example/workspaces) — purely local, no server call")
    .option("--write", "merge the proposal into <dir>/drop.yaml (refuses to overwrite an existing stack: section)")
    .option("--force", "with --write, overwrite an existing stack: section")
    .action(async (dir: string | undefined, opts: { write?: boolean; force?: boolean }) => {
      const target = dir ?? ".";
      const { spec, notes } = await runDetect(target);
      if (Object.keys(spec.resources).length === 0) {
        console.log(`  (nothing detected in ${target})`);
        for (const n of notes) console.log(`  · ${n}`);
        return;
      }
      console.log(serializeDetectedStack(spec).replace(/\n$/, ""));
      for (const n of notes) console.log(`  · ${n}`);
      if (opts.write) {
        const { path, created } = await writeDetectedStack(target, spec, { force: opts.force });
        console.log(`  ✓ ${created ? "wrote" : "updated"} ${path}`);
      } else {
        console.log(`  tip: pass --write to merge this into ${target === "." ? "" : target + "/"}${CONFIG_FILE_YAML}`);
      }
    });

  // ---- templates (D1): the golden-path registry ----
  const template = program.command("template").description("Publish + browse reusable stack templates");
  template
    .command("publish")
    .description("Publish a template from an existing stack (--from-stack) or a drop.yaml stack: section (--file)")
    .requiredOption("--slug <slug>", "template slug (3–40 chars, DNS-label shaped) — the `drop new <slug>` name")
    .option("--from-stack <name>", "export an existing stack (captures its deployed images; strips secrets/digests)")
    .option("--file <path>", "read the stack: section from this drop.yaml (default: ./drop.yaml)")
    .option("--name <name>", "human-facing template name (default: the slug)")
    .option("--description <text>", "one-line description for the catalog card")
    .option("--visibility <v>", "public (instance-wide) or org (members only)", "org")
    .option("--var <spec>", "declare a variable: key:description:default (repeatable)", collect, [])
    .option("--required <key>", "mark a declared variable required (repeatable)", collect, [])
    .option("--secret <key>", "mark a declared variable secret — never stored in the spec (repeatable)", collect, [])
    .option("--readme <path>", "attach a README file (rendered on the template page)")
    .option("--allow <key>", "allow a flagged credential-looking env value through (audited; repeatable)", collect, [])
    .option("--org <slug>", "publish into this organisation (default: your personal org)")
    .action(
      async (opts: {
        slug: string;
        fromStack?: string;
        file?: string;
        name?: string;
        description?: string;
        visibility?: string;
        var: string[];
        required: string[];
        secret: string[];
        readme?: string;
        allow: string[];
        org?: string;
      }) => {
        const requiredSet = new Set(opts.required);
        const secretSet = new Set(opts.secret);
        const variables = opts.var.map((s) => parseVarSpec(s, requiredSet, secretSet));
        const readme = opts.readme ? await readFile(opts.readme, "utf8") : undefined;
        const visibility = opts.visibility === "public" ? "public" : "org";
        const payload: Parameters<Client["templatePublish"]>[0] = {
          slug: opts.slug,
          name: opts.name,
          description: opts.description,
          visibility,
          variables,
          readme,
          allow: opts.allow,
          org: opts.org,
        };
        if (opts.fromStack) {
          payload.from_stack = opts.fromStack;
        } else {
          const path = opts.file ?? join(".", CONFIG_FILE_YAML);
          const text = await readFile(path, "utf8");
          const spec = parseStackConfig(text);
          if (!spec) throw new Error(`${path} has no valid stack: section (needs a name and at least one resource)`);
          payload.spec = spec;
        }
        const res = await (await client()).templatePublish(payload);
        console.log(`  ✓ published template ${res.slug} v${res.version} (${res.visibility}) — ${res.resources} resource(s)`);
        for (const n of res.notes ?? []) console.log(`    · ${n}`);
        for (const r of res.removed ?? []) console.log(`    · removed secret env ${r.resourceKey}.${r.envKey}`);
        console.log(`  deploy it with:  drop new ${res.slug}`);
      },
    );
  template
    .command("ls")
    .description("List templates you can see (public + your orgs')")
    .action(async () => show(await (await client()).templateList()));
  template
    .command("show <slug>")
    .description("Show a template's variables, readme, and spec")
    .option("--version <v>", "a specific version (default: latest)")
    .action(async (slug: string, opts: { version?: string }) => show(await (await client()).templateGet(slug, opts.version)));

  // `drop new <slug>` — instantiate a template into a new stack (prompts for missing required vars on a TTY).
  program
    .command("new <slug>")
    .description("Instantiate a template into a new stack (resolves variables, runs up, writes returned secrets)")
    .option("--version <v>", "instantiate a specific version (default: latest)")
    .option("--org <slug>", "create in this organisation (default: your personal org)")
    .option("--set <k=v>", "set a variable value (repeatable; wins over prompts)", collect, [])
    .option("--name <stackname>", "the new stack's name (default: the slug)")
    .option("--dry-run", "resolve + print the plan without creating anything")
    .action(async (slug: string, opts: { version?: string; org?: string; set: string[]; name?: string; dryRun?: boolean }) => {
      const c = await client();
      const tpl = await c.templateGet(slug, opts.version);
      const variables: TemplateVarSpec[] = tpl.variables ?? [];
      let values = parseSets(opts.set);
      values = await promptMissingVars(variables, values);
      const name = opts.name ?? slug;
      const err = validateName(name);
      if (err) throw new Error(`stack name "${name}": ${err}`);

      const res = await c.templateInstantiate(slug, { name, org: opts.org, vars: values, version: opts.version }, opts.dryRun);
      if (opts.dryRun || res.dryRun) {
        console.log(`  plan for ${name} (from ${slug} v${res.version ?? tpl.version}):`);
        for (const s of res.plan ?? []) console.log(`    ${s.action.padEnd(6)} ${s.kind.padEnd(9)} ${s.key} → ${s.siteName}`);
        if ((res.secretsToSet ?? []).length) console.log(`  would set ${res.secretsToSet.length} secret(s): ${res.secretsToSet.map((s: any) => `${s.app}.${s.key}`).join(", ")}`);
        console.log("  (dry run — nothing applied)");
        return;
      }
      console.log(`  ✓ stack ${res.stack} created from template ${slug} v${res.version} (spec v${res.specVersion})`);
      // Write the secrets the server lifted out of the spec, then restart the apps that got them.
      const secrets: { app: string; key: string; value: string }[] = res.secretsToSet ?? [];
      const restarted = new Set<string>();
      for (const s of secrets) {
        await c.setSecret(s.app, s.key, s.value);
        console.log(`    · set secret ${s.app}.${s.key}`);
      }
      for (const s of secrets) {
        if (restarted.has(s.app)) continue;
        restarted.add(s.app);
        await c.restartApp(s.app).catch(() => {}); // best-effort: the app may be scale-to-zero / not yet started
      }
      for (const need of res.needs ?? []) {
        console.log(`    · note: resource ${need.key} still needs ${need.kind} (build/publish it, or re-run from source)`);
      }
      console.log(`  view it:  drop stack status ${res.stack}`);
    });

  const db = program.command("db").description("Manage managed Postgres databases (create / password / proxy)");
  db
    .command("create <name> [dir]")
    .description("Create a managed Postgres database (reads the database: section from dir/drop.yaml if present)")
    .option("--org <slug>", "create in this organisation (default: your personal org)")
    .option("--ext <list>", "comma-separated Postgres extensions to create at bootstrap (e.g. pgvector,pg_trgm) — allowlisted; create-time only")
    .action(async (name: string, dir: string | undefined, opts: { org?: string; ext?: string }) => {
      const err = validateName(name);
      if (err) throw new Error(err);
      const cfg = await loadDatabaseCreate(dir ?? ".");
      // (I3) `--ext a,b` merges into the config's extensions (server validates against the allowlist).
      if (opts.ext) {
        const exts = opts.ext.split(",").map((s) => s.trim()).filter(Boolean);
        if (exts.length) (cfg as Record<string, unknown>).extensions = exts;
      }
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

  // (A3) db:proxy — an authenticated psql tunnel. A local TCP listener; each connection rides a fresh
  // single-use ticket over an authenticated WebSocket to the API, which authorizes (per-user `connect`),
  // audits, and splices to the DB in-cluster. Unlike `drop db expose` (L4), it needs no exposure opt-in,
  // carries real per-user authz + audit, and works on deployments with no L4 plane.
  db
    .command("proxy <name>")
    .description("Open an authenticated local psql tunnel to a managed database (per-user authz + audit; no exposure opt-in)")
    .option("--port <n>", "local port to listen on (default: an ephemeral port, printed)", (v) => parseInt(v, 10))
    .action(async (name: string, opts: { port?: number }) => {
      const err = validateName(name);
      if (err) throw new Error(err);
      const s = await session();
      const proxy = await runDbProxy({
        session: s,
        db: name,
        port: opts.port,
        onError: (e) => console.error(`  ⚠ tunnel connection failed: ${e.message}`),
      });
      console.log(`  ✓ tunnel to ${name} listening on 127.0.0.1:${proxy.port}`);
      console.log(`     connect:  psql "host=127.0.0.1 port=${proxy.port} sslmode=disable"`);
      console.log(`     (each connection is authorized + audited; the local hop is loopback, the DB hop is the authenticated tunnel)`);
      console.log(`     Ctrl-C to stop.`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => {
          console.log("\n  ▸ closing tunnel…");
          void proxy.close().then(resolve);
        });
      });
    });

  // (I3) connection pooling (CNPG Pooler / PgBouncer)
  const pooler = db.command("pooler").description("Manage the database's connection pooler (PgBouncer)");
  pooler
    .command("enable <name>")
    .description("Enable a PgBouncer connection pooler for the database (bind apps with `uses: [{ database, via: pooler }]`)")
    .option("--mode <mode>", "pool mode: transaction (default) or session", "transaction")
    .action(async (name: string, opts: { mode?: string }) => {
      const mode = opts.mode === "session" ? "session" : "transaction";
      const res = (await (await client()).dbPooler(name, true, mode)) as { pooler: { mode: string; host: string } };
      console.log(`  ✓ pooler enabled for ${name} (${res.pooler.mode} mode)`);
      console.log(`     host: ${res.pooler.host}  — apps bound with via: pooler route PGHOST here`);
    });
  pooler
    .command("disable <name>")
    .description("Disable (delete) the database's connection pooler")
    .action(async (name: string) => {
      await (await client()).dbPooler(name, false);
      console.log(`  ✓ pooler disabled for ${name}`);
    });

  // (I3) extensions — create-time only; `ext add` on an existing db 409s honestly.
  const ext = db.command("ext").description("Manage the database's Postgres extensions (create-time only)");
  ext
    .command("ls <name>")
    .description("List the extensions created on the database (from the stored config)")
    .action(async (name: string) => {
      const info = (await (await client()).info(name)) as { database?: { extensions?: string[] } };
      const exts = info.database?.extensions ?? [];
      console.log(exts.length ? `  ${exts.join(", ")}` : "  (none)");
    });
  ext
    .command("add <name> <extensions>")
    .description("Add extensions to an EXISTING database — v1 limitation: extensions are create-time only (recreate with --ext)")
    .action(async (name: string, extensions: string) => {
      const exts = extensions.split(",").map((s) => s.trim()).filter(Boolean);
      await (await client()).dbExtAdd(name, exts); // server returns a clear 409
    });

  // ---- caches (managed Valkey, I2) ----
  const cache = program.command("cache").description("Manage managed caches (Valkey — create / ls / rm)");
  cache
    .command("create <name> [dir]")
    .description("Create a managed Valkey cache (EPHEMERAL by default — a restart loses data unless --persistent). Reads cache: from dir/drop.yaml if present.")
    .option("--org <slug>", "create in this organisation (default: your personal org)")
    .option("--memory <size>", "memory (a k8s quantity, 64Mi–1Gi; default 256Mi)")
    .option("--persistent", "add a small PVC so data survives restarts (default: ephemeral)")
    .action(async (name: string, dir: string | undefined, opts: { org?: string; memory?: string; persistent?: boolean }) => {
      const err = validateName(name);
      if (err) throw new Error(err);
      const cfg = (await loadCacheCreate(dir ?? ".")) as Record<string, unknown>;
      if (opts.memory) cfg.memory = opts.memory;
      if (opts.persistent) cfg.persistent = true;
      console.log(`  ▸ creating cache ${name}…`);
      const res = (await (await client()).cacheCreate(name, cfg as never, opts.org)) as {
        memory: string; persistent: boolean; host: string; port: number; url: string;
      };
      console.log(`  ✓ cache ready — ${res.memory}, ${res.persistent ? "persistent" : "EPHEMERAL (a restart loses all data)"}`);
      console.log(`     host: ${res.host}:${res.port}`);
      console.log(`  ✓ connection URL — shown once, store it now (or bind with \`uses: [{ cache: ${name} }]\` to inject REDIS_URL automatically):`);
      console.log(`     ${res.url}`);
    });
  cache
    .command("ls")
    .description("List your caches")
    .option("--org <slug>", "show only caches in this organisation")
    .action(async (opts: { org?: string }) => show(await (await client()).cacheList(opts.org)));
  cache
    .command("rm <name>")
    .description("Delete a cache (tears down the Valkey + its data — there is no cache backup)")
    .action(async (name: string) => show(await (await client()).remove(name)));

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

  program
    .command("status <name>")
    .description("One-line edge traffic rate for a workload (requests, p95 latency, error %, bytes out)")
    .option("--range <r>", "window: 1h | 24h | 7d (default 1h)", "1h")
    .action(async (name: string, opts: { range?: string }) => {
      const range = opts.range === "24h" || opts.range === "7d" ? opts.range : "1h";
      const res = (await (await client()).metrics(name, range)) as {
        totals: { requests: number; errors: number; bytesOut: number; p50: number; p95: number };
      };
      const t = res.totals;
      const errPct = t.requests > 0 ? ((t.errors / t.requests) * 100).toFixed(1) : "0.0";
      const window = range === "24h" ? "last 24h" : range === "7d" ? "last 7d" : "last hour";
      const kib = 1024;
      const bytes = t.bytesOut < kib ? `${t.bytesOut} B` : t.bytesOut < kib * kib ? `${(t.bytesOut / kib).toFixed(1)} KiB` : t.bytesOut < kib * kib * kib ? `${(t.bytesOut / (kib * kib)).toFixed(1)} MiB` : `${(t.bytesOut / (kib * kib * kib)).toFixed(1)} GiB`;
      console.log(`  ${name} (${window}): ${t.requests} req · p50 ${t.p50}ms · p95 ${t.p95}ms · ${errPct}% errors · ${bytes} out`);
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
