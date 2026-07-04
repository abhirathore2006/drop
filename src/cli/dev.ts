// `drop dev [app] [-- cmd…]` — the local inner loop (L3). It composes machinery that already exists:
//   (1) fetch the app's dev-context (GET /v1/apps/:name/dev-context) — its NON-secret env, its DB/cache
//       binding metadata, and the NAMES of the secret keys it expects (never values);
//   (2) for each tunnelable binding, open an A3-style authorized tunnel (reusing `db:proxy`'s
//       `runDbProxy`) on an allocated local port — per-user authorized + AUDITED via the ticket model,
//       so a `drop dev` against a prod-org DB is as visible + gated as any `drop db proxy`;
//   (3) materialize an env: the app's non-secret env + binding hosts rewritten to `localhost:<port>`
//       (PGHOST/PGPORT for a DB, the host inside REDIS_URL for a cache) + the `--env-file .env.dev`
//       overlay (developer-owned local dev credentials for the secret keys — since secrets are never
//       pulled);
//   (4) exec the user's command (or the app's L1 web-process command) with that env, inheriting stdio,
//       and tear the tunnels down on exit (Ctrl-C / SIGTERM / child-exit).
//
// SECRETS STAY WRITE-ONLY — NEVER PULLED. dev-context carries key NAMES only; the developer supplies
// values locally via `--env-file`. `drop dev --check` prints those names + a ready-to-fill `.env.dev`.
//
// IN-CLUSTER-TUNNEL CONSTRAINT (same as `db:proxy`): the tunnel dials the DB Service in-cluster, so it
// only splices when the API runs inside the cluster (DROP_TUNNEL_DIRECT). Against a local out-of-cluster
// API the per-connection dial 501s (surfaced, never fatal); `--no-tunnel` skips tunnels entirely so the
// env still materializes from the app env + .env.dev (point PGHOST/REDIS_URL at your own local DB there).
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { runDbProxy, type TunnelSession } from "./db-proxy.ts";
import { Client } from "./client.ts";
import type { Session } from "./session.ts";

/** One DB/cache binding `drop dev` may rewrite to a local tunnel port. Mirrors the server's dev-context
 *  shape (src/api/server.ts). Non-secret throughout — host/port + injected-var NAMES only. */
export interface DevBinding {
  kind: "database" | "cache";
  resource: string;
  host: string;
  port: number;
  hostVar?: string; // database: PGHOST
  portVar?: string; // database: PGPORT
  urlVar?: string; // cache: REDIS_URL (or <LABEL>_REDIS_URL)
  tunnelTicketPath: string | null; // present → tunnelable (A3); null → not tunneled on this instance
}

/** The dev-context the API returns (non-secret env + bindings + secret KEY NAMES + the default cmd). */
export interface DevContext {
  app: string;
  namespace: string;
  env: Record<string, string>;
  bindings: DevBinding[];
  secretKeys: string[]; // NAMES only — never values
  command: string[] | string | null; // the web-process command `drop dev` defaults to
}

/** A live tunnel: its allocated local port + a teardown. Matches `runDbProxy`'s return shape so the
 *  default opener is a thin wrapper; injectable so orchestration is testable without a real listener. */
export interface DevTunnel {
  port: number;
  close: () => Promise<void>;
}

/** The child process `drop dev` supervises — the minimal surface we drive (real `ChildProcess` fits). */
export interface DevChild {
  on(event: "exit", cb: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals | string): unknown;
}

/** Injectable seams so `runDev`'s orchestration is unit-testable without the network, a TCP listener,
 *  or a real subprocess. Defaults wire the real Client / runDbProxy / child_process.spawn / fs. */
export interface DevDeps {
  loadContext: (app: string) => Promise<DevContext>;
  openTunnel: (b: DevBinding) => Promise<DevTunnel>;
  spawnProcess: (argv: string[], env: Record<string, string>) => DevChild;
  readFileMaybe: (path: string) => Promise<string | null>;
  log: (s: string) => void;
}

export interface DevOptions {
  app: string;
  command?: string[]; // the user's `-- cmd` (overrides the app's default web command)
  envFile?: string; // overlay file (default: .env.dev if present)
  check?: boolean; // --check: print secret key names + a .env.dev template, then exit
  noTunnel?: boolean; // --no-tunnel: skip tunnels, materialize env-only (local out-of-cluster API)
}

// -------------------------------------------------------------------------------------------------
// Pure helpers (table-tested) — the env-materialization core carries NO I/O and NO process globals.
// -------------------------------------------------------------------------------------------------

/** Rewrite a redis URL's host:port to the local tunnel, PRESERVING userinfo/path (so the developer's
 *  own password from .env.dev keeps working while traffic routes through the authorized tunnel). A
 *  missing/unparseable URL → a bare `redis://localhost:<port>` (a local cache with no auth). */
export function rewriteRedisHost(url: string | undefined, port: number): string {
  if (!url) return `redis://localhost:${port}`;
  try {
    const u = new URL(url);
    u.hostname = "localhost";
    u.port = String(port);
    return u.toString();
  } catch {
    return `redis://localhost:${port}`;
  }
}

/**
 * Build the env `drop dev` runs the command with. Precedence, lowest → highest:
 *   1. the app's NON-secret env (dev-context.env — the `<name>-env` source);
 *   2. the `.env.dev` overlay (developer-owned local values for the secret keys — secrets are never
 *      pulled, so THIS is where credentials come from);
 *   3. the tunnel host-rewrites — ALWAYS last (the allocated local port is the authoritative address):
 *        · database → hostVar=localhost, portVar=<port>;
 *        · cache    → rewrite the host inside urlVar to localhost:<port> (keeping the overlay's creds).
 * A binding with no entry in `tunnelPorts` (no tunnel opened — a cache, or a tunnel that was skipped)
 * is left to steps 1–2, i.e. the developer's own .env.dev value. Pure: no I/O, no globals.
 */
export function materializeDevEnv(
  ctx: Pick<DevContext, "env" | "bindings">,
  tunnelPorts: Record<string, number>,
  overlay: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = { ...ctx.env, ...overlay };
  for (const b of ctx.bindings) {
    const port = tunnelPorts[b.resource];
    if (port == null) continue; // no tunnel for this binding → its host env stays app-env/.env.dev
    if (b.kind === "database") {
      env[b.hostVar ?? "PGHOST"] = "localhost";
      env[b.portVar ?? "PGPORT"] = String(port);
    } else {
      const key = b.urlVar ?? "REDIS_URL";
      env[key] = rewriteRedisHost(env[key], port);
    }
  }
  return env;
}

/** Parse a `.env`-style overlay: `KEY=VALUE` per line; blank + `#` lines skipped; a leading `export `
 *  tolerated; surrounding single/double quotes stripped. No interpolation — these are dev credentials,
 *  not a shell. The value keeps any `=` after the first one (base64 secrets, connection URLs). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const s = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) val = val.slice(1, -1);
    if (key) out[key] = val;
  }
  return out;
}

/** Render a ready-to-fill `.env.dev` template (--check): every secret KEY NAME the app expects with an
 *  empty value, plus a hint for each DB binding's connection creds (which live in the `<db>-app` Secret
 *  and are never pulled). Names only — never a value. */
export function renderEnvTemplate(ctx: DevContext): string {
  const lines: string[] = [
    `# .env.dev — LOCAL dev credentials for ${ctx.app}.`,
    `# Secrets are NEVER pulled from Drop — fill these with your OWN local/dev values.`,
    `# 'drop dev' overlays this file on the app's non-secret env + tunnel-rewritten hosts.`,
    ``,
  ];
  if (ctx.secretKeys.length === 0) lines.push(`# (this app declares no write-only secret keys)`);
  else for (const k of ctx.secretKeys) lines.push(`${k}=`);
  const dbs = ctx.bindings.filter((b) => b.kind === "database");
  if (dbs.length) {
    lines.push(``, `# database binding(s): the tunnel rewrites PGHOST/PGPORT to a local port; supply the`, `# connection creds (PGPASSWORD lives in the <db>-app Secret — never pulled; PGUSER/PGDATABASE default to 'app'):`);
    for (const b of dbs) lines.push(`# ${b.resource}: PGPASSWORD=   PGUSER=app   PGDATABASE=app`);
  }
  return lines.join("\n") + "\n";
}

/** The web-process command as an argv the shell can exec: a string is shell-form (`/bin/sh -c`), an
 *  array is exec-form passthrough (matches AppProcess.command's convention). null → no default. */
export function normalizeCommand(command: string[] | string | null | undefined): string[] | null {
  if (command == null) return null;
  if (typeof command === "string") return command.length ? ["/bin/sh", "-c", command] : null;
  return command.length ? command : null;
}

// -------------------------------------------------------------------------------------------------
// Orchestration
// -------------------------------------------------------------------------------------------------

/** Print the --check surface: the secret KEY NAMES the app expects (never values) + a .env.dev template. */
function printCheck(ctx: DevContext, log: (s: string) => void): void {
  log(`  ${ctx.app}: secret keys the app expects (NAMES only — values are never pulled):`);
  if (ctx.secretKeys.length === 0) log(`    (none declared)`);
  else for (const k of ctx.secretKeys) log(`    · ${k}`);
  for (const b of ctx.bindings) {
    const how = b.tunnelTicketPath
      ? b.kind === "database"
        ? `tunneled → ${b.hostVar}/${b.portVar} rewritten to localhost`
        : `tunneled → ${b.urlVar} host rewritten to localhost`
      : `NOT tunneled here → set ${b.urlVar ?? b.hostVar ?? "its connection env"} in your .env.dev`;
    log(`    binding: ${b.kind} ${b.resource} @ ${b.host}:${b.port} (${how})`);
  }
  log(``);
  log(`  ready-to-fill .env.dev template:`);
  log(renderEnvTemplate(ctx));
}

/** Load the `.env.dev` overlay: an explicit `--env-file` is required to exist; the implicit default
 *  (`.env.dev`) is optional (absent → empty overlay). Returns the parsed KEY→VALUE map. */
async function loadOverlay(opts: DevOptions, deps: DevDeps): Promise<Record<string, string>> {
  const path = opts.envFile ?? ".env.dev";
  const explicit = opts.envFile != null;
  const text = await deps.readFileMaybe(path);
  if (text == null) {
    if (explicit) throw new Error(`--env-file ${path} not found`);
    return {}; // no default .env.dev present — that's fine (all values may come from the app env)
  }
  const overlay = parseEnvFile(text);
  deps.log(`  ✓ overlaid ${Object.keys(overlay).length} value(s) from ${path}`);
  return overlay;
}

async function teardown(tunnels: { resource: string; close: () => Promise<void> }[]): Promise<void> {
  await Promise.all(tunnels.map((t) => t.close().catch(() => {})));
}

/** The default opener: reuse `db:proxy`'s `runDbProxy` — a local listener whose every connection rides a
 *  fresh single-use ticket over an authenticated WebSocket (per-user authz + `db.tunnel.open` audit). */
function defaultOpenTunnel(session: TunnelSession, log: (s: string) => void): (b: DevBinding) => Promise<DevTunnel> {
  return (b) =>
    runDbProxy({
      session,
      db: b.resource, // tunnelable bindings are databases (their ticket path is /v1/databases/…)
      onError: (e) => log(`  ⚠ tunnel to ${b.resource} — a connection failed: ${e.message} (tunnels need an in-cluster API, same as \`drop db proxy\`)`),
    });
}

/**
 * Compose + run the local inner loop. Returns the child's exit code. Deps are injectable for tests; the
 * defaults wire the real network / tunnel / subprocess. Non-`--check` runs: open tunnels → materialize
 * env → spawn → supervise. Tunnels are always torn down (child exit / signal / early error).
 */
export async function runDev(opts: DevOptions, session: TunnelSession, overrides: Partial<DevDeps> = {}): Promise<number> {
  const log = overrides.log ?? ((s: string) => console.log(s));
  const deps: DevDeps = {
    log,
    loadContext: overrides.loadContext ?? (async (app) => (await new Client(session as Session).devContext(app)) as DevContext),
    openTunnel: overrides.openTunnel ?? defaultOpenTunnel(session, log),
    spawnProcess: overrides.spawnProcess ?? ((argv, env) => spawn(argv[0]!, argv.slice(1), { stdio: "inherit", env }) as unknown as DevChild),
    readFileMaybe: overrides.readFileMaybe ?? (async (p) => readFile(p, "utf8").catch(() => null)),
  };

  const ctx = await deps.loadContext(opts.app);

  if (opts.check) {
    printCheck(ctx, log);
    return 0;
  }

  const overlay = await loadOverlay(opts, deps);

  // Open an A3 tunnel per tunnelable binding (databases today). A non-tunnelable binding (a cache — no
  // cache tunnel WS endpoint yet) is reported, and its host env is left to .env.dev. `--no-tunnel` skips
  // all tunnels (the local out-of-cluster posture: rely on .env.dev for every connection host).
  const tunnels: { resource: string; close: () => Promise<void> }[] = [];
  const tunnelPorts: Record<string, number> = {};
  if (!opts.noTunnel) {
    for (const b of ctx.bindings) {
      if (!b.tunnelTicketPath) {
        log(`  ⚠ ${b.kind} "${b.resource}" is not tunneled on this instance — set ${b.urlVar ?? b.hostVar ?? "its connection env"} in ${opts.envFile ?? ".env.dev"} to point at a local ${b.kind}`);
        continue;
      }
      try {
        const t = await deps.openTunnel(b);
        tunnels.push({ resource: b.resource, close: t.close });
        tunnelPorts[b.resource] = t.port;
        const rewrote = b.kind === "database" ? `${b.hostVar}=localhost ${b.portVar}=${t.port}` : `${b.urlVar} host→localhost:${t.port}`;
        log(`  ✓ tunnel to ${b.resource} (${b.kind}) on 127.0.0.1:${t.port} — rewrites ${rewrote}`);
      } catch (e) {
        // A tunnel that can't even bind is non-fatal: degrade to .env.dev / app env for that binding.
        log(`  ⚠ tunnel to ${b.resource} unavailable (${(e as Error).message}) — using ${opts.envFile ?? ".env.dev"} / app env for it`);
      }
    }
  } else {
    log(`  ▸ --no-tunnel: skipping tunnels — connection hosts come from ${opts.envFile ?? ".env.dev"} / the app env`);
  }

  const env = materializeDevEnv(ctx, tunnelPorts, overlay);

  const argv = opts.command?.length ? opts.command : normalizeCommand(ctx.command);
  if (!argv || !argv.length) {
    await teardown(tunnels);
    throw new Error(`no command to run — pass one after \`--\` (e.g. \`drop dev ${opts.app} -- npm run dev\`) or declare a web-process command in drop.yaml`);
  }

  log(`  ▸ running: ${argv.join(" ")}`);
  const child = deps.spawnProcess(argv, { ...(process.env as Record<string, string>), ...env });

  return await new Promise<number>((resolve) => {
    let settled = false;
    const onSignal = () => {
      log(`\n  ▸ shutting down — tearing tunnels down…`);
      child.kill("SIGTERM"); // forward; the child's exit drives teardown + resolve below
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      void teardown(tunnels).then(() => resolve(code ?? 0));
    });
  });
}
