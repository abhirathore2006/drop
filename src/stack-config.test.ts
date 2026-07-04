import { test, expect } from "bun:test";
import { sanitizeStackConfig, validateStackEdges, resolveResourceName, parseStackConfig, type StackSpec } from "./stack-config.ts";

const yaml = (s: string) => s;

test("sanitizeStackConfig: a full three-resource spec (db + app + site) with both edge kinds", () => {
  const spec = sanitizeStackConfig({
    name: "shop",
    resources: {
      db: { type: "database", storage: "512Mi" },
      api: {
        type: "app",
        dir: "./api",
        uses: [{ database: "db" }],
        expose: { tcp: false },
        env: { NODE_ENV: "production" },
        scale: { min: 1, max: 3 },
      },
      web: {
        type: "site",
        dir: "./web/dist",
        env_from: [{ resource: "api", output: "url", as: "API_BASE" }],
      },
    },
  })!;
  expect(spec.name).toBe("shop");
  expect(Object.keys(spec.resources).sort()).toEqual(["api", "db", "web"]);

  const db = spec.resources.db!;
  expect(db.type).toBe("database");
  expect(db.storage).toBe("512Mi");
  expect(db.hibernation).toBe("none");

  const api = spec.resources.api!;
  expect(api.type).toBe("app");
  expect(api.dir).toBe("./api");
  expect(api.image).toBeUndefined(); // dir-based app → no image yet (CLI builds it)
  expect(api.uses).toEqual([{ database: "db" }]); // edge references the resource KEY
  expect(api.expose).toEqual({ tcp: false });
  expect(api.env).toEqual({ NODE_ENV: "production" });
  expect(api.scale).toEqual({ min: 1, max: 3 });
  expect(api.services).toEqual([{ internalPort: 8080, protocol: "http" }]); // default service

  const web = spec.resources.web!;
  expect(web.type).toBe("site");
  expect(web.dir).toBe("./web/dist");
  expect(web.env_from).toEqual([{ resource: "api", output: "url", as: "API_BASE" }]);
});

test("sanitizeStackConfig: no name, no resources, or all-junk resources → undefined", () => {
  expect(sanitizeStackConfig({ resources: { db: { type: "database" } } })).toBeUndefined(); // no name
  expect(sanitizeStackConfig({ name: "x", resources: {} })).toBeUndefined(); // no resources
  expect(sanitizeStackConfig({ name: "Bad_Name", resources: { db: { type: "database" } } })).toBeUndefined(); // bad name
  expect(sanitizeStackConfig({ name: "x" })).toBeUndefined(); // resources missing
  expect(sanitizeStackConfig("nonsense")).toBeUndefined();
  expect(sanitizeStackConfig({ name: "x", resources: { a: { type: "wat" }, b: 5, c: null } })).toBeUndefined(); // all entries invalid
});

test("sanitizeStackConfig: junk fields ignored; a pinned image is kept; unknown types dropped", () => {
  const spec = sanitizeStackConfig({
    name: "svc",
    garbage: 123,
    resources: {
      api: { type: "app", image: "svc:1", nonsense: true, resources: { cpu: "250m", memory: "256Mi" } },
      bogus: { type: "unknown" }, // dropped
      "Bad Key": { type: "app", image: "x:1" }, // invalid DNS key → dropped
    },
  })!;
  expect(Object.keys(spec.resources)).toEqual(["api"]);
  expect(spec.resources.api!.image).toBe("svc:1");
  expect(spec.resources.api!.resources).toEqual({ cpu: "250m", memory: "256Mi" });
  expect((spec.resources.api as unknown as Record<string, unknown>).nonsense).toBeUndefined();
});

test("sanitizeStackConfig: an explicit name: override is preserved per resource", () => {
  const spec = sanitizeStackConfig({
    name: "shop",
    resources: { db: { type: "database", name: "shared-pg" } },
  })!;
  expect(spec.resources.db!.name).toBe("shared-pg");
  expect(resolveResourceName("shop", "db", spec.resources.db!)).toBe("shared-pg");
});

test("resolveResourceName: default is <stack>-<key>", () => {
  const spec = sanitizeStackConfig({ name: "shop", resources: { db: { type: "database" } } })!;
  expect(resolveResourceName("shop", "db", spec.resources.db!)).toBe("shop-db");
});

test("sanitizeStackConfig: caps resources at 16", () => {
  const resources: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) resources[`r${i}`] = { type: "database" };
  const spec = sanitizeStackConfig({ name: "big", resources })!;
  expect(Object.keys(spec.resources).length).toBe(16);
});

test("sanitizeStackConfig: env_from drops malformed entries (bad output, bad var name, missing fields)", () => {
  const spec = sanitizeStackConfig({
    name: "s",
    resources: {
      api: { type: "app", image: "x:1" },
      web: {
        type: "site",
        env_from: [
          { resource: "api", output: "url", as: "API_BASE" }, // ok
          { resource: "api", output: "secret", as: "X" }, // bad output → dropped
          { resource: "api", output: "url", as: "1BAD" }, // bad var name → dropped
          { output: "url", as: "Y" }, // missing resource → dropped
        ],
      },
    },
  })!;
  expect(spec.resources.web!.env_from).toEqual([{ resource: "api", output: "url", as: "API_BASE" }]);
});

test("round-trip: re-sanitizing a StackSpec yields an identical spec", () => {
  const once = sanitizeStackConfig({
    name: "shop",
    resources: {
      db: { type: "database", storage: "1Gi" },
      api: { type: "app", dir: "./api", uses: [{ database: "db" }], env: { A: "b" }, expose: { tcp: true } },
      web: { type: "site", dir: "./web", env_from: [{ resource: "api", output: "url", as: "API" }] },
    },
  })!;
  const twice = sanitizeStackConfig(once as unknown)!;
  expect(twice).toEqual(once);
});

test("validateStackEdges: accepts sound edges; names the offender otherwise", () => {
  const ok = sanitizeStackConfig({
    name: "s",
    resources: {
      db: { type: "database" },
      api: { type: "app", image: "x:1", uses: [{ database: "db" }] },
      web: { type: "site", env_from: [{ resource: "api", output: "url", as: "API" }] },
    },
  })!;
  expect(validateStackEdges(ok)).toBeNull();

  // app uses a KEY that isn't in the stack
  const missing: StackSpec = { name: "s", resources: { api: { type: "app", image: "x:1", uses: [{ database: "ghost" }] } } };
  expect(validateStackEdges(missing)).toContain("ghost");

  // app uses a KEY that is a site, not a database
  const wrongType: StackSpec = {
    name: "s",
    resources: { web: { type: "site" }, api: { type: "app", image: "x:1", uses: [{ database: "web" }] } },
  };
  expect(validateStackEdges(wrongType)).toContain("not a database");

  // site env_from a KEY that is a database, not an app
  const badEnvFrom: StackSpec = {
    name: "s",
    resources: { db: { type: "database" }, web: { type: "site", env_from: [{ resource: "db", output: "url", as: "X" }] } },
  };
  expect(validateStackEdges(badEnvFrom)).toContain("not an app");
});

test("stack: bucket resource + app→bucket `uses` edge (I1)", () => {
  const spec = sanitizeStackConfig({
    name: "s",
    resources: {
      files: { type: "bucket" },
      api: { type: "app", image: "x:1", uses: [{ bucket: "files" }] },
    },
  })!;
  expect(spec.resources.files).toEqual({ type: "bucket" });
  expect(spec.resources.api!.uses).toEqual([{ bucket: "files" }]);
  expect(validateStackEdges(spec)).toBeNull();

  // app uses a bucket KEY that isn't in the stack
  const missing: StackSpec = { name: "s", resources: { api: { type: "app", image: "x:1", uses: [{ bucket: "ghost" }] } } };
  expect(validateStackEdges(missing)).toContain("ghost");

  // app uses a KEY that is a database, not a bucket
  const wrongType: StackSpec = {
    name: "s",
    resources: { db: { type: "database" }, api: { type: "app", image: "x:1", uses: [{ bucket: "db" }] } },
  };
  expect(validateStackEdges(wrongType)).toContain("not a bucket");
});

test("stack: cache resource + app→cache `uses` edge (I2); via:pooler carried on a db use (I3)", () => {
  const spec = sanitizeStackConfig({
    name: "s",
    resources: {
      db: { type: "database" },
      sessions: { type: "cache", memory: "512Mi", persistent: true },
      api: { type: "app", image: "x:1", uses: [{ cache: "sessions" }, { database: "db", via: "pooler" }] },
    },
  })!;
  expect(spec.resources.sessions).toEqual({ type: "cache", memory: "512Mi", persistent: true });
  expect(spec.resources.api!.uses).toEqual([{ cache: "sessions" }, { database: "db", via: "pooler" }]);
  expect(validateStackEdges(spec)).toBeNull();

  // app uses a cache KEY that isn't in the stack
  const missing: StackSpec = { name: "s", resources: { api: { type: "app", image: "x:1", uses: [{ cache: "ghost" }] } } };
  expect(validateStackEdges(missing)).toContain("ghost");

  // app uses a KEY that is a database, not a cache
  const wrongType: StackSpec = {
    name: "s",
    resources: { db: { type: "database" }, api: { type: "app", image: "x:1", uses: [{ cache: "db" }] } },
  };
  expect(validateStackEdges(wrongType)).toContain("not a cache");
});

test("stack: auth resource (K1) + auth→db edge + app→auth `uses` edge", () => {
  const spec = sanitizeStackConfig({
    name: "s",
    resources: {
      db: { type: "database" },
      login: { type: "auth", db: "db", signup: "closed", redirect_urls: ["https://app.example.com/cb"] },
      api: { type: "app", image: "x:1", uses: [{ auth: "login" }] },
    },
  })!;
  expect(spec.resources.login).toEqual({ type: "auth", db: "db", signup: "closed", redirect_urls: ["https://app.example.com/cb"], jwt_ttl: "1h" });
  expect(spec.resources.api!.uses).toEqual([{ auth: "login" }]);
  expect(validateStackEdges(spec)).toBeNull();

  // an auth resource without a `db` → rejected
  const noDb: StackSpec = { name: "s", resources: { login: { type: "auth" } } };
  expect(validateStackEdges(noDb)).toContain("must declare a \"db\"");

  // auth `db` names a non-database → rejected
  const wrongDb: StackSpec = { name: "s", resources: { c: { type: "cache", memory: "128Mi", persistent: false }, login: { type: "auth", db: "c" } } };
  expect(validateStackEdges(wrongDb)).toContain("not a database");

  // app uses a KEY that is a database, not an auth resource
  const wrongType: StackSpec = { name: "s", resources: { db: { type: "database" }, api: { type: "app", image: "x:1", uses: [{ auth: "db" }] } } };
  expect(validateStackEdges(wrongType)).toContain("not an auth resource");
});

test("parseStackConfig: reads the top-level stack: section of a drop.yaml body", () => {
  const spec = parseStackConfig(
    yaml(`
stack:
  name: myproduct
  resources:
    db:  { type: database, storage: 1Gi }
    api:
      type: app
      dir: ./api
      uses: [{ database: db }]
      env: { NODE_ENV: production }
    web:
      type: site
      dir: ./web/dist
      env_from: [{ resource: api, output: url, as: API_BASE }]
`),
  )!;
  expect(spec.name).toBe("myproduct");
  expect(spec.resources.db!.storage).toBe("1Gi");
  expect(spec.resources.api!.uses).toEqual([{ database: "db" }]);
  expect(spec.resources.web!.env_from![0]!.as).toBe("API_BASE");
  // an old CLI that doesn't know stack: sees nothing under app:/site:/database:
  expect(parseStackConfig("site:\n  name: foo\n")).toBeUndefined();
});
