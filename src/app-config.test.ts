import { test, expect } from "bun:test";
import { sanitizeAppConfig, parseAppConfig, assertHttpOnly, assertProcesses, expandProcesses } from "./app-config.ts";

test("sanitizeAppConfig requires an image", () => {
  expect(sanitizeAppConfig({})).toBeUndefined();
  expect(sanitizeAppConfig({ name: "x" })).toBeUndefined();
  expect(sanitizeAppConfig("nope")).toBeUndefined();
  expect(sanitizeAppConfig(undefined)).toBeUndefined();
});

test("sanitizeAppConfig parses image, name, resources, env, services, scale; drops junk", () => {
  const c = sanitizeAppConfig({
    name: "billing",
    image: "ecr/billing:v1",
    resources: { cpu: "0.5", memory: "512Mi" },
    env: { NODE_ENV: "production", BAD: 123 },
    services: [{ internal_port: 8080, protocol: "http" }],
    scale: { min: 0, max: 3 },
    junk: true,
  })!;
  expect(c.image).toBe("ecr/billing:v1");
  expect(c.name).toBe("billing");
  expect(c.resources).toEqual({ cpu: "0.5", memory: "512Mi" });
  expect(c.env).toEqual({ NODE_ENV: "production" }); // non-string dropped
  expect(c.services).toEqual([{ internalPort: 8080, protocol: "http" }]);
  expect(c.scale).toEqual({ min: 0, max: 3 });
  expect((c as any).junk).toBeUndefined();
});

test("sanitizeAppConfig defaults services to one http port 8080", () => {
  expect(sanitizeAppConfig({ image: "x:1" })!.services).toEqual([{ internalPort: 8080, protocol: "http" }]);
});

test("sanitizeAppConfig ignores an invalid name and a malformed scale", () => {
  const c = sanitizeAppConfig({ image: "x:1", name: "Bad_Name", scale: { min: 5, max: 2 } })!;
  expect(c.name).toBeUndefined(); // failed validateName
  expect(c.scale).toBeUndefined(); // max < min
});

test("parseAppConfig reads the app: section; undefined when absent", () => {
  const c = parseAppConfig("app:\n  image: ecr/x:1\n  scale: { min: 0, max: 3 }\n")!;
  expect(c.image).toBe("ecr/x:1");
  expect(c.scale).toEqual({ min: 0, max: 3 });
  expect(parseAppConfig("site:\n  name: s\n")).toBeUndefined();
  expect(parseAppConfig("")).toBeUndefined();
});

test("assertHttpOnly enforces the v1 443-only rule (one http service)", () => {
  expect(() => assertHttpOnly({ image: "x", services: [{ internalPort: 8080, protocol: "http" }] })).not.toThrow();
  expect(() => assertHttpOnly({ image: "x", services: [{ internalPort: 5432, protocol: "tcp" }] })).toThrow(/tcp/i);
  expect(() =>
    assertHttpOnly({
      image: "x",
      services: [
        { internalPort: 80, protocol: "http" },
        { internalPort: 81, protocol: "http" },
      ],
    }),
  ).toThrow(/one service/i);
});

test("sanitizeAppConfig is round-trip safe (CLI sanitizes -> JSON -> API re-sanitizes)", () => {
  const once = sanitizeAppConfig({ image: "x:1", services: [{ internal_port: 80, protocol: "http" }] })!;
  const twice = sanitizeAppConfig(JSON.parse(JSON.stringify(once)))!; // feed the sanitized object back in
  expect(twice.services).toEqual([{ internalPort: 80, protocol: "http" }]); // port survives, not defaulted to 8080
});

test("sanitizeAppConfig defaults resources (never unbounded) and trusted=true by default", () => {
  const c = sanitizeAppConfig({ image: "x:1" })!;
  expect(c.resources).toEqual({ cpu: "0.5", memory: "512Mi" }); // LIM-1: never unbounded
  expect(c.trusted).toBe(true); // internal-trusted default (no sandbox dependency)
  expect(sanitizeAppConfig({ image: "x:1", trusted: false })!.trusted).toBe(false); // opt into sandbox
});

test("sanitizeAppConfig parses uses:[{database}], dropping junk / wrong shapes / bad names / dupes", () => {
  const c = sanitizeAppConfig({
    image: "x:1",
    uses: [
      { database: "tododb" },
      { database: "Bad_Name" }, // fails validateName → dropped
      { database: "tododb" }, // duplicate → collapsed
      { cache: "nope" }, // wrong shape (no `database`) → dropped
      "junk", // not an object → dropped
      { database: 123 }, // non-string → dropped
      { database: "" }, // empty → dropped
    ],
  })!;
  expect(c.uses).toEqual([{ database: "tododb" }]);
});

test("sanitizeAppConfig omits uses when absent / not an array / all-invalid; caps the list at 8", () => {
  expect(sanitizeAppConfig({ image: "x:1" })!.uses).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", uses: "nope" })!.uses).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", uses: [{ cache: "x" }] })!.uses).toBeUndefined();
  const many = Array.from({ length: 12 }, (_, i) => ({ database: `db${i}` })); // 12 distinct valid names
  expect(sanitizeAppConfig({ image: "x:1", uses: many })!.uses!.length).toBe(8); // capped
});

test("sanitizeAppConfig parses uses:[{bucket}] (I1) alongside {database}; dedupes per kind; round-trips", () => {
  const c = sanitizeAppConfig({
    image: "x:1",
    uses: [
      { database: "tododb" },
      { bucket: "avatars" },
      { bucket: "avatars" }, // duplicate bucket → collapsed
      { bucket: "Bad_Name" }, // fails validateName → dropped
      { bucket: 42 }, // non-string → dropped
    ],
  })!;
  expect(c.uses).toEqual([{ database: "tododb" }, { bucket: "avatars" }]);
  // round-trip safe
  const twice = sanitizeAppConfig(JSON.parse(JSON.stringify(c)))!;
  expect(twice.uses).toEqual([{ database: "tododb" }, { bucket: "avatars" }]);
});

test("sanitizeAppConfig uses is round-trip safe (CLI sanitizes -> JSON -> API re-sanitizes)", () => {
  const once = sanitizeAppConfig({ image: "x:1", uses: [{ database: "tododb" }] })!;
  const twice = sanitizeAppConfig(JSON.parse(JSON.stringify(once)))!; // feed the sanitized object back in
  expect(twice.uses).toEqual([{ database: "tododb" }]);
});

// ---- healthcheck ----

test("sanitizeAppConfig healthcheck: parses durations, applies defaults, clamps bounds", () => {
  const c = sanitizeAppConfig({ image: "x:1", healthcheck: { path: "/healthz", interval: "10s", timeout: "2s", grace: "15s" } })!;
  expect(c.healthcheck).toEqual({ path: "/healthz", interval: 10, timeout: 2, grace: 15 });
  // defaults when fields absent
  expect(sanitizeAppConfig({ image: "x:1", healthcheck: { path: "/live" } })!.healthcheck).toEqual({ path: "/live", interval: 10, timeout: 2, grace: 15 });
  // out-of-bounds clamp to [1,300]/[1,60]/[0,600]; "5m" = 300s
  const b = sanitizeAppConfig({ image: "x:1", healthcheck: { path: "/h", interval: "5m", timeout: 999, grace: 9999 } })!;
  expect(b.healthcheck).toEqual({ path: "/h", interval: 300, timeout: 60, grace: 600 });
  // a negative (unparseable) duration falls back to the default rather than clamping
  expect(sanitizeAppConfig({ image: "x:1", healthcheck: { path: "/h", grace: -5 } })!.healthcheck!.grace).toBe(15);
});

test("sanitizeAppConfig healthcheck: junk / relative path drops the block (→ default TCP probe)", () => {
  expect(sanitizeAppConfig({ image: "x:1", healthcheck: "nope" })!.healthcheck).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", healthcheck: { path: "healthz" } })!.healthcheck).toBeUndefined(); // must start with /
  expect(sanitizeAppConfig({ image: "x:1", healthcheck: {} })!.healthcheck).toBeUndefined(); // no path
  // junk durations fall back to the default rather than failing
  expect(sanitizeAppConfig({ image: "x:1", healthcheck: { path: "/h", interval: "soon" } })!.healthcheck).toEqual({ path: "/h", interval: 10, timeout: 2, grace: 15 });
});

test("sanitizeAppConfig healthcheck is round-trip safe", () => {
  const once = sanitizeAppConfig({ image: "x:1", healthcheck: { path: "/z", interval: "30s" } })!;
  const twice = sanitizeAppConfig(JSON.parse(JSON.stringify(once)))!;
  expect(twice.healthcheck).toEqual({ path: "/z", interval: 30, timeout: 2, grace: 15 });
});

// ---- release ----

test("sanitizeAppConfig release: string shorthand + object form; timeout default 5m, cap 15m", () => {
  expect(sanitizeAppConfig({ image: "x:1", release: "npm run migrate" })!.release).toEqual({ command: "npm run migrate", timeout: 300 });
  expect(sanitizeAppConfig({ image: "x:1", release: { command: "./migrate", timeout: "10m" } })!.release).toEqual({ command: "./migrate", timeout: 600 });
  expect(sanitizeAppConfig({ image: "x:1", release: { command: "m", timeout: "1h" } })!.release).toEqual({ command: "m", timeout: 900 }); // capped at 15m
});

test("sanitizeAppConfig release: no/empty command drops the block", () => {
  expect(sanitizeAppConfig({ image: "x:1", release: "" })!.release).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", release: { timeout: "5m" } })!.release).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", release: 123 })!.release).toBeUndefined();
});

test("sanitizeAppConfig release is round-trip safe (object form re-sanitizes)", () => {
  const once = sanitizeAppConfig({ image: "x:1", release: "migrate" })!;
  const twice = sanitizeAppConfig(JSON.parse(JSON.stringify(once)))!;
  expect(twice.release).toEqual({ command: "migrate", timeout: 300 });
});

// ---- processes ----

test("sanitizeAppConfig processes: parses web + worker, command string/array, scale, resources", () => {
  const c = sanitizeAppConfig({
    image: "x:1",
    processes: {
      web: { command: "node server.js" },
      worker: { command: ["node", "worker.js"], scale: { min: 2, max: 4 }, resources: { cpu: "250m" } },
      junk: "nope", // non-object value → dropped
      Bad_Name: { command: "x" }, // invalid key → dropped
    },
  })!;
  expect(c.processes).toEqual({
    web: { command: "node server.js" },
    worker: { command: ["node", "worker.js"], scale: { min: 2, max: 4 }, resources: { cpu: "250m" } },
  });
});

test("sanitizeAppConfig processes: absent → undefined; all-invalid → undefined", () => {
  expect(sanitizeAppConfig({ image: "x:1" })!.processes).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", processes: [] })!.processes).toBeUndefined(); // array, not a map
  expect(sanitizeAppConfig({ image: "x:1", processes: { Bad_Name: {} } })!.processes).toBeUndefined();
});

test("sanitizeAppConfig processes: scale_on reserved (L1b) round-trips as scaleOn, accepts both spellings", () => {
  const c = sanitizeAppConfig({ image: "x:1", processes: { worker: { command: "w", scale_on: { queue: "jobs", target: 10 } } } })!;
  expect(c.processes!.worker!.scaleOn).toEqual({ queue: "jobs", target: 10 });
  // re-sanitize the sanitized (scaleOn) form → unchanged
  const twice = sanitizeAppConfig(JSON.parse(JSON.stringify(c)))!;
  expect(twice.processes!.worker!.scaleOn).toEqual({ queue: "jobs", target: 10 });
  // junk scale_on dropped
  expect(sanitizeAppConfig({ image: "x:1", processes: { w: { command: "w", scale_on: { queue: "jobs" } } } })!.processes!.w!.scaleOn).toBeUndefined();
});

test("assertProcesses: at most one web — two webs throw (deploy 400s); zero/one are fine", () => {
  // key `web` + another process explicitly web:true → two webs
  const two = sanitizeAppConfig({ image: "x:1", processes: { web: { command: "a" }, worker: { web: true, command: "b" } } })!;
  expect(() => assertProcesses(two)).toThrow(/at most one "web"/);
  // one web (default) is fine
  expect(() => assertProcesses(sanitizeAppConfig({ image: "x:1", processes: { web: { command: "a" }, worker: { command: "b" } } })!)).not.toThrow();
  // worker-only (zero web) is legal
  expect(() => assertProcesses(sanitizeAppConfig({ image: "x:1", processes: { worker: { command: "b" } } })!)).not.toThrow();
  // absent processes never throws
  expect(() => assertProcesses(sanitizeAppConfig({ image: "x:1" })!)).not.toThrow();
});

test("expandProcesses: absent → one implicit web using app-level scale/resources", () => {
  const app = sanitizeAppConfig({ image: "x:1", scale: { min: 0, max: 3 }, resources: { cpu: "0.5" } })!;
  expect(expandProcesses(app, "todo")).toEqual([{ name: "todo", process: "web", web: true, scale: { min: 0, max: 3 }, resources: { cpu: "0.5" } }]);
});

test("expandProcesses: workers get min≥1 static scale; per-process resources override; web keeps app scale", () => {
  const app = sanitizeAppConfig({
    image: "x:1",
    scale: { min: 0, max: 5 },
    resources: { cpu: "0.5", memory: "512Mi" },
    processes: {
      web: {},
      worker: { command: "node w.js", scale: { min: 0, max: 3 }, resources: { cpu: "1" } }, // min 0 clamped to 1
      solo: { command: "node s.js" }, // no scale → static {1,1}
    },
  })!;
  const procs = expandProcesses(app, "app");
  const web = procs.find((p) => p.process === "web")!;
  expect(web).toMatchObject({ name: "app", web: true, scale: { min: 0, max: 5 }, resources: { cpu: "0.5", memory: "512Mi" } });
  const worker = procs.find((p) => p.process === "worker")!;
  expect(worker).toMatchObject({ name: "app-worker", web: false, scale: { min: 1, max: 3 }, resources: { cpu: "1" } }); // min clamped, resources overridden
  const solo = procs.find((p) => p.process === "solo")!;
  expect(solo).toMatchObject({ name: "app-solo", web: false, scale: { min: 1, max: 1 } }); // default static single replica
});

test("expandProcesses: worker-only app has no web process", () => {
  const app = sanitizeAppConfig({ image: "x:1", processes: { worker: { command: "w" } } })!;
  const procs = expandProcesses(app, "batch");
  expect(procs.some((p) => p.web)).toBe(false);
  expect(procs).toHaveLength(1);
  expect(procs[0]!.name).toBe("batch-worker");
});

// ---- H2: schedule (cron) ----

test("sanitizeAppConfig schedule: accepts numbers/ranges/steps/lists/*, normalizes whitespace", () => {
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *" })!.schedule).toBe("0 3 * * *");
  expect(sanitizeAppConfig({ image: "x:1", schedule: "*/15 * * * *" })!.schedule).toBe("*/15 * * * *"); // step on *
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 0,12 * * *" })!.schedule).toBe("0 0,12 * * *"); // list
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 9-17 * * 1-5" })!.schedule).toBe("0 9-17 * * 1-5"); // range
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0-30/10 * * * *" })!.schedule).toBe("0-30/10 * * * *"); // range + step
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 0 * * 7" })!.schedule).toBe("0 0 * * 7"); // 7 = Sunday, accepted
  expect(sanitizeAppConfig({ image: "x:1", schedule: "  0   3  *  *  * " })!.schedule).toBe("0 3 * * *"); // whitespace normalized
});

test("sanitizeAppConfig schedule: junk is dropped (key absent), never throws", () => {
  expect(sanitizeAppConfig({ image: "x:1", schedule: "not a cron" })!.schedule).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * *" })!.schedule).toBeUndefined(); // 4 fields
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * * *" })!.schedule).toBeUndefined(); // 6 fields
  expect(sanitizeAppConfig({ image: "x:1", schedule: "60 3 * * *" })!.schedule).toBeUndefined(); // minute out of range
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 24 * * *" })!.schedule).toBeUndefined(); // hour out of range
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 3 0 * *" })!.schedule).toBeUndefined(); // day-of-month 0 (1-31 only)
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * 13 *" })!.schedule).toBeUndefined(); // month out of range
  expect(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * 8" })!.schedule).toBeUndefined(); // dow out of range
  expect(sanitizeAppConfig({ image: "x:1", schedule: "-1 3 * * *" })!.schedule).toBeUndefined(); // negative
  expect(sanitizeAppConfig({ image: "x:1", schedule: "5-1 3 * * *" })!.schedule).toBeUndefined(); // inverted range
  expect(sanitizeAppConfig({ image: "x:1", schedule: "*/0 * * * *" })!.schedule).toBeUndefined(); // step 0
  expect(sanitizeAppConfig({ image: "x:1", schedule: "soon" })!.schedule).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", schedule: "" })!.schedule).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1", schedule: 123 })!.schedule).toBeUndefined();
  expect(sanitizeAppConfig({ image: "x:1" })!.schedule).toBeUndefined();
});

test("sanitizeAppConfig schedule is round-trip safe (CLI sanitizes -> JSON -> API re-sanitizes)", () => {
  const once = sanitizeAppConfig({ image: "x:1", schedule: "*/5 * * * *" })!;
  const twice = sanitizeAppConfig(JSON.parse(JSON.stringify(once)))!;
  expect(twice.schedule).toBe("*/5 * * * *");
});

test("sanitizeAppConfig command: string -> shell form, array -> exec form, junk dropped", () => {
  expect(sanitizeAppConfig({ image: "x:1", command: "python run.py" })!.command).toBe("python run.py");
  expect(sanitizeAppConfig({ image: "x:1", command: ["python", "run.py"] })!.command).toEqual(["python", "run.py"]);
  expect(sanitizeAppConfig({ image: "x:1", command: "" })!.command).toBeUndefined(); // empty string
  expect(sanitizeAppConfig({ image: "x:1", command: [] })!.command).toBeUndefined(); // empty array
  expect(sanitizeAppConfig({ image: "x:1", command: [123, "ok"] })!.command).toEqual(["ok"]); // non-string entries dropped
  expect(sanitizeAppConfig({ image: "x:1", command: 42 })!.command).toBeUndefined(); // wrong type
  expect(sanitizeAppConfig({ image: "x:1" })!.command).toBeUndefined(); // absent
});

test("sanitizeAppConfig command is round-trip safe", () => {
  const once = sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", command: ["node", "job.js"] })!;
  const twice = sanitizeAppConfig(JSON.parse(JSON.stringify(once)))!;
  expect(twice.schedule).toBe("0 3 * * *");
  expect(twice.command).toEqual(["node", "job.js"]);
});

test("assertProcesses: schedule is mutually exclusive with processes", () => {
  const app = sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", processes: { worker: { command: "w" } } })!;
  expect(() => assertProcesses(app)).toThrow(/schedule.*processes|processes.*schedule/i);
});

test("assertProcesses: schedule is mutually exclusive with an explicitly-declared services", () => {
  const app = sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", services: [{ internal_port: 9090, protocol: "http" }] })!;
  expect(() => assertProcesses(app)).toThrow(/schedule.*services|services.*schedule/i);
});

test("assertProcesses: schedule is mutually exclusive with healthcheck", () => {
  const app = sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", healthcheck: { path: "/healthz" } })!;
  expect(() => assertProcesses(app)).toThrow(/schedule.*healthcheck|healthcheck.*schedule/i);
});

test("assertProcesses: schedule + the implicit default service (no services declared) is ACCEPTED", () => {
  const app = sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *" })!;
  expect(app.services).toEqual([{ internalPort: 8080, protocol: "http" }]); // still defaulted by the sanitizer
  expect(() => assertProcesses(app)).not.toThrow();
});

test("assertProcesses: schedule + services explicitly re-stating the default shape is ALSO accepted (documented tradeoff)", () => {
  const app = sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", services: [{ internal_port: 8080, protocol: "http" }] })!;
  expect(() => assertProcesses(app)).not.toThrow();
});

test("assertProcesses: schedule + release is fine (release is unaffected by H2)", () => {
  const app = sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", release: "npm run migrate" })!;
  expect(() => assertProcesses(app)).not.toThrow();
});
