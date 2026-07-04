import { test, expect } from "bun:test";
import {
  materializeDevEnv,
  rewriteRedisHost,
  parseEnvFile,
  renderEnvTemplate,
  normalizeCommand,
  runDev,
  type DevContext,
  type DevBinding,
  type DevChild,
  type DevDeps,
} from "./dev.ts";

const dbBinding = (resource: string, over: Partial<DevBinding> = {}): DevBinding => ({
  kind: "database",
  resource,
  host: `${resource}-rw.acme.svc.cluster.local`,
  port: 5432,
  hostVar: "PGHOST",
  portVar: "PGPORT",
  tunnelTicketPath: `/v1/databases/${resource}/tunnel-ticket`,
  ...over,
});
const cacheBinding = (resource: string, over: Partial<DevBinding> = {}): DevBinding => ({
  kind: "cache",
  resource,
  host: `${resource}.acme.svc.cluster.local`,
  port: 6379,
  urlVar: "REDIS_URL",
  tunnelTicketPath: null,
  ...over,
});

const ctx = (over: Partial<DevContext> = {}): DevContext => ({
  app: "billing",
  namespace: "acme",
  env: {},
  bindings: [],
  secretKeys: [],
  command: null,
  ...over,
});

// -------------------------------------------------------------------------------------------------
// materializeDevEnv — the env-materialization core (table-tested)
// -------------------------------------------------------------------------------------------------

test("materializeDevEnv: passes NON-secret app env through unchanged", () => {
  const env = materializeDevEnv({ env: { NODE_ENV: "development", PORT: "3000" }, bindings: [] }, {}, {});
  expect(env).toEqual({ NODE_ENV: "development", PORT: "3000" });
});

test("materializeDevEnv: a DB tunnel rewrites PGHOST=localhost + PGPORT=<port>", () => {
  const env = materializeDevEnv({ env: { PGHOST: "billing-rw.acme.svc.cluster.local", PGPORT: "5432" }, bindings: [dbBinding("billing")] }, { billing: 55432 }, {});
  expect(env.PGHOST).toBe("localhost");
  expect(env.PGPORT).toBe("55432");
});

test("materializeDevEnv: a cache tunnel rewrites the REDIS_URL host, PRESERVING the .env.dev password", () => {
  const env = materializeDevEnv(
    { env: {}, bindings: [cacheBinding("sessions", { tunnelTicketPath: "/v1/caches/sessions/tunnel-ticket" })] },
    { sessions: 63790 },
    { REDIS_URL: "redis://:mypw@sessions.acme.svc.cluster.local:6379/2" },
  );
  expect(env.REDIS_URL).toBe("redis://:mypw@localhost:63790/2");
});

test("materializeDevEnv: a cache tunnel with no REDIS_URL synthesizes redis://localhost:<port>", () => {
  const env = materializeDevEnv({ env: {}, bindings: [cacheBinding("c", { tunnelTicketPath: "x" })] }, { c: 6390 }, {});
  expect(env.REDIS_URL).toBe("redis://localhost:6390");
});

test("materializeDevEnv: honors a prefixed cache var (multiple caches → <LABEL>_REDIS_URL)", () => {
  const env = materializeDevEnv(
    { env: {}, bindings: [cacheBinding("sessions", { urlVar: "SESSIONS_REDIS_URL", tunnelTicketPath: "x" })] },
    { sessions: 6390 },
    { SESSIONS_REDIS_URL: "redis://:pw@sessions.acme.svc:6379" },
  );
  expect(env.SESSIONS_REDIS_URL).toBe("redis://:pw@localhost:6390");
});

test("materializeDevEnv: precedence — overlay beats app env; tunnel rewrite beats BOTH", () => {
  const env = materializeDevEnv(
    { env: { PGHOST: "app-env-host", PGPORT: "5432", API_KEY: "app-env-key" }, bindings: [dbBinding("billing")] },
    { billing: 55432 },
    { PGHOST: "dotenv-host", API_KEY: "dotenv-key" }, // overlay
  );
  expect(env.API_KEY).toBe("dotenv-key"); // overlay wins over app env
  expect(env.PGHOST).toBe("localhost"); // tunnel wins over overlay
  expect(env.PGPORT).toBe("55432");
});

test("materializeDevEnv: a binding with NO tunnel port is left to app-env/.env.dev (no rewrite)", () => {
  const env = materializeDevEnv(
    { env: {}, bindings: [cacheBinding("c")] }, // cache not tunneled → not in tunnelPorts
    {}, // no ports
    { REDIS_URL: "redis://:pw@my-local:6379" },
  );
  expect(env.REDIS_URL).toBe("redis://:pw@my-local:6379"); // untouched
});

// -------------------------------------------------------------------------------------------------
// rewriteRedisHost / parseEnvFile / renderEnvTemplate / normalizeCommand — pure helpers
// -------------------------------------------------------------------------------------------------

test("rewriteRedisHost: preserves userinfo + path, swaps host:port", () => {
  expect(rewriteRedisHost("redis://:s3cr3t@h:6379/0", 63790)).toBe("redis://:s3cr3t@localhost:63790/0");
});
test("rewriteRedisHost: missing/garbage URL → bare local url", () => {
  expect(rewriteRedisHost(undefined, 6390)).toBe("redis://localhost:6390");
  expect(rewriteRedisHost("not a url", 6390)).toBe("redis://localhost:6390");
});

test("parseEnvFile: comments/blanks skipped, quotes stripped, export tolerated, = kept in value", () => {
  const m = parseEnvFile(`# a comment\n\nexport A=1\nB="quoted"\nC='single'\nURL=redis://:p@h:6379/0\nBAD\n=nokey`);
  expect(m).toEqual({ A: "1", B: "quoted", C: "single", URL: "redis://:p@h:6379/0" });
});

test("renderEnvTemplate: lists every secret KEY NAME with an empty value — NEVER a value", () => {
  const t = renderEnvTemplate(ctx({ secretKeys: ["API_KEY", "STRIPE_KEY"], bindings: [dbBinding("billing")] }));
  expect(t).toContain("API_KEY=");
  expect(t).toContain("STRIPE_KEY=");
  expect(t).not.toContain("s3cr3t"); // no values ever
  expect(t).toContain("PGPASSWORD="); // DB creds hint (never pulled)
});

test("normalizeCommand: string → shell-form; array → passthrough; null → null", () => {
  expect(normalizeCommand("npm run dev")).toEqual(["/bin/sh", "-c", "npm run dev"]);
  expect(normalizeCommand(["node", "server.js"])).toEqual(["node", "server.js"]);
  expect(normalizeCommand(null)).toBeNull();
  expect(normalizeCommand("")).toBeNull();
});

// -------------------------------------------------------------------------------------------------
// runDev — orchestration (mocked tunnel + spawn; no network, no listener, no subprocess)
// -------------------------------------------------------------------------------------------------

/** A fake child that lets the test drive its exit. */
function fakeChild(): DevChild & { fire: (code: number) => void; killed: string[] } {
  let cb: ((code: number | null) => void) | undefined;
  const killed: string[] = [];
  return {
    on(_e, f) {
      cb = f;
    },
    kill(sig) {
      killed.push(String(sig ?? "SIGTERM"));
    },
    fire(code) {
      cb?.(code);
    },
    killed,
  };
}

const session = { apiBase: "http://api.test", token: "t" };

test("runDev --check: prints secret KEY NAMES (no values), opens NO tunnels, spawns NOTHING", async () => {
  const logs: string[] = [];
  let opened = 0;
  let spawned = 0;
  const code = await runDev(
    { app: "billing", check: true },
    session,
    {
      loadContext: async () => ctx({ secretKeys: ["API_KEY"], bindings: [dbBinding("billing")] }),
      openTunnel: async () => {
        opened++;
        return { port: 1, close: async () => {} };
      },
      spawnProcess: () => {
        spawned++;
        return fakeChild();
      },
      readFileMaybe: async () => null,
      log: (s) => logs.push(s),
    },
  );
  expect(code).toBe(0);
  expect(opened).toBe(0);
  expect(spawned).toBe(0);
  const out = logs.join("\n");
  expect(out).toContain("API_KEY");
  expect(out).not.toContain("s3cr3t");
});

test("runDev: opens ONE tunnel per tunnelable binding, materializes env, tears down on child exit", async () => {
  const logs: string[] = [];
  const openedFor: string[] = [];
  const closedFor: string[] = [];
  const child = fakeChild();
  let spawnEnv: Record<string, string> = {};

  const deps: Partial<DevDeps> = {
    loadContext: async () =>
      ctx({
        env: { NODE_ENV: "development" },
        bindings: [dbBinding("billingdb"), cacheBinding("sessions")], // 1 tunnelable DB + 1 non-tunnelable cache
        command: ["node", "server.js"],
      }),
    openTunnel: async (b) => {
      openedFor.push(b.resource);
      return { port: 55000 + openedFor.length, close: async () => void closedFor.push(b.resource) };
    },
    spawnProcess: (_argv, env) => {
      spawnEnv = env;
      return child;
    },
    readFileMaybe: async () => "PGPASSWORD=localpw\n",
    log: (s) => logs.push(s),
  };

  const p = runDev({ app: "billing", command: [] }, session, deps);
  await new Promise((r) => setTimeout(r, 0)); // let orchestration reach spawn + register exit handler
  child.fire(0);
  const code = await p;

  expect(code).toBe(0);
  expect(openedFor).toEqual(["billingdb"]); // ONLY the DB was tunneled (cache has a null ticket path)
  expect(closedFor).toEqual(["billingdb"]); // torn down on exit
  // env: app env passthrough + overlay + tunnel rewrite
  expect(spawnEnv.NODE_ENV).toBe("development");
  expect(spawnEnv.PGPASSWORD).toBe("localpw"); // from .env.dev overlay
  expect(spawnEnv.PGHOST).toBe("localhost");
  expect(spawnEnv.PGPORT).toBe("55001");
  // the non-tunnelable cache is surfaced to the developer
  expect(logs.join("\n")).toContain('cache "sessions" is not tunneled');
});

test("runDev --no-tunnel: opens NO tunnels; env comes from app env + .env.dev only", async () => {
  const openedFor: string[] = [];
  const child = fakeChild();
  let spawnEnv: Record<string, string> = {};
  const p = runDev(
    { app: "billing", command: ["node", "x.js"], noTunnel: true },
    session,
    {
      loadContext: async () => ctx({ bindings: [dbBinding("billingdb")] }),
      openTunnel: async (b) => {
        openedFor.push(b.resource);
        return { port: 1, close: async () => {} };
      },
      spawnProcess: (_argv, env) => {
        spawnEnv = env;
        return child;
      },
      readFileMaybe: async () => "PGHOST=my-local-db\nPGPORT=5432\n",
      log: () => {},
    },
  );
  await new Promise((r) => setTimeout(r, 0));
  child.fire(0);
  await p;
  expect(openedFor).toEqual([]); // no tunnels
  expect(spawnEnv.PGHOST).toBe("my-local-db"); // .env.dev value, NOT rewritten to localhost
});

test("runDev: no command anywhere → throws (and opens no tunnels)", async () => {
  let opened = 0;
  await expect(
    runDev({ app: "billing", command: [] }, session, {
      loadContext: async () => ctx({ command: null }),
      openTunnel: async () => {
        opened++;
        return { port: 1, close: async () => {} };
      },
      spawnProcess: () => fakeChild(),
      readFileMaybe: async () => null,
      log: () => {},
    }),
  ).rejects.toThrow(/no command to run/);
  expect(opened).toBe(0);
});

test("runDev: an explicit --env-file that is missing → throws", async () => {
  await expect(
    runDev({ app: "billing", command: ["x"], envFile: "nope.env" }, session, {
      loadContext: async () => ctx(),
      openTunnel: async () => ({ port: 1, close: async () => {} }),
      spawnProcess: () => fakeChild(),
      readFileMaybe: async () => null, // file absent
      log: () => {},
    }),
  ).rejects.toThrow(/nope\.env not found/);
});
