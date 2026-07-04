import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { detectStack, createMemoryFileTree } from "./detect.ts";
import { createFsFileTree } from "./fs-tree.ts";

// ---------------------------------------------------------------------------------------------
// Pure table tests — one in-memory FileTree per heuristic, no IO.
// ---------------------------------------------------------------------------------------------

test("Dockerfile alone → an app resource, dir '.'", async () => {
  const files = createMemoryFileTree({ Dockerfile: "FROM node" });
  const { spec, notes } = await detectStack(files, { name: "myapp" });
  expect(spec.name).toBe("myapp");
  expect(spec.resources).toEqual({ app: { type: "app", dir: "." } });
  expect(notes.some((n) => n.includes("Dockerfile"))).toBe(true);
});

test("Dockerfile casing variants all match", async () => {
  for (const name of ["Dockerfile", "dockerfile", "DOCKERFILE", "DockerFile"]) {
    const { spec } = await detectStack(createMemoryFileTree({ [name]: "FROM node" }));
    expect(spec.resources.app?.type).toBe("app");
  }
});

test("no Dockerfile, no package.json, no signals → nothing detected", async () => {
  const { spec, notes } = await detectStack(createMemoryFileTree({ "README.md": "hi" }));
  expect(spec.resources).toEqual({});
  expect(notes.some((n) => n.includes("no resource detected"))).toBe(true);
});

describe("Postgres signals (Dockerfile present, so there's an app to bind to)", () => {
  test("prisma/ directory", async () => {
    const { spec } = await detectStack(createMemoryFileTree({ Dockerfile: "x", "prisma/schema.prisma": "x" }));
    expect(spec.resources).toEqual({
      app: { type: "app", dir: ".", uses: [{ database: "db" }] },
      db: { type: "database" },
    });
  });

  test.each(["pg", "postgres", "postgres.js", "drizzle-orm"])("%s in dependencies", async (dep) => {
    const files = createMemoryFileTree({ Dockerfile: "x", "package.json": JSON.stringify({ dependencies: { [dep]: "1.0.0" } }) });
    const { spec } = await detectStack(files);
    expect(spec.resources.db).toEqual({ type: "database" });
    expect(spec.resources.app?.uses).toEqual([{ database: "db" }]);
  });

  test("in devDependencies too", async () => {
    const files = createMemoryFileTree({ Dockerfile: "x", "package.json": JSON.stringify({ devDependencies: { pg: "1.0.0" } }) });
    const { spec } = await detectStack(files);
    expect(spec.resources.db).toEqual({ type: "database" });
  });

  test("DATABASE_URL in .env.example", async () => {
    const files = createMemoryFileTree({ Dockerfile: "x", ".env.example": "DATABASE_URL=postgres://localhost/app\n" });
    const { spec } = await detectStack(files);
    expect(spec.resources.db).toEqual({ type: "database" });
  });

  test("PG* in .env.example", async () => {
    const files = createMemoryFileTree({ Dockerfile: "x", ".env.example": "PGHOST=db\nPGPORT=5432\n" });
    const { spec } = await detectStack(files);
    expect(spec.resources.db).toEqual({ type: "database" });
  });

  test("a PG-looking var that isn't actually a PG* env line doesn't false-positive", async () => {
    // "PGSOMETHING" mid-line (not at line start) shouldn't match — regex requires `^PG` per line.
    const files = createMemoryFileTree({ Dockerfile: "x", ".env.example": "FOO=PGHOST\n" });
    const { spec } = await detectStack(files);
    expect(spec.resources.db).toBeUndefined();
  });
});

describe("Redis signals (Dockerfile present)", () => {
  test.each(["ioredis", "redis", "bullmq"])("%s in dependencies", async (dep) => {
    const files = createMemoryFileTree({ Dockerfile: "x", "package.json": JSON.stringify({ dependencies: { [dep]: "1.0.0" } }) });
    const { spec } = await detectStack(files);
    expect(spec.resources.cache).toEqual({ type: "cache" });
    expect(spec.resources.app?.uses).toEqual([{ cache: "cache" }]);
  });

  test("REDIS_URL in .env.example", async () => {
    const files = createMemoryFileTree({ Dockerfile: "x", ".env.example": "REDIS_URL=redis://localhost:6379\n" });
    const { spec } = await detectStack(files);
    expect(spec.resources.cache).toEqual({ type: "cache" });
  });

  test("both database and cache signals bind to the same app in one uses: array", async () => {
    const files = createMemoryFileTree({
      Dockerfile: "x",
      "package.json": JSON.stringify({ dependencies: { pg: "1", ioredis: "1" } }),
    });
    const { spec } = await detectStack(files);
    expect(spec.resources.app?.uses).toEqual([{ database: "db" }, { cache: "cache" }]);
    expect(Object.keys(spec.resources).sort()).toEqual(["app", "cache", "db"]);
  });
});

test("Postgres/Redis signals with NO Dockerfile and no site → nothing to bind to, skipped", async () => {
  const files = createMemoryFileTree({ "package.json": JSON.stringify({ dependencies: { pg: "1", ioredis: "1" } }) });
  const { spec, notes } = await detectStack(files);
  expect(spec.resources).toEqual({});
  expect(notes.some((n) => n.includes("no Dockerfile/app here to bind"))).toBe(true);
});

describe("static build detection (no Dockerfile)", () => {
  test("existing dist/index.html is the strongest signal → dir: dist", async () => {
    const files = createMemoryFileTree({
      "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "dist/index.html": "<html></html>",
    });
    const { spec } = await detectStack(files);
    expect(spec.resources).toEqual({ site: { type: "site", dir: "dist" } });
  });

  test("build script mentioning 'dist' (no dist/ yet) → dir: dist", async () => {
    const files = createMemoryFileTree({ "package.json": JSON.stringify({ scripts: { build: "tsc && cp -r assets dist/" } }) });
    const { spec } = await detectStack(files);
    expect(spec.resources.site).toEqual({ type: "site", dir: "dist" });
  });

  test("build script mentioning 'out' wins over the weaker 'build' token", async () => {
    const files = createMemoryFileTree({ "package.json": JSON.stringify({ scripts: { build: "next build && next export -o out" } }) });
    const { spec } = await detectStack(files);
    expect(spec.resources.site).toEqual({ type: "site", dir: "out" });
  });

  test("build script with only the generic 'build' token (e.g. CRA) → dir: build", async () => {
    const files = createMemoryFileTree({ "package.json": JSON.stringify({ scripts: { build: "react-scripts build" } }) });
    const { spec } = await detectStack(files);
    expect(spec.resources.site).toEqual({ type: "site", dir: "build" });
  });

  test("a build script with none of dist/out/build as whole words → no site detected", async () => {
    const files = createMemoryFileTree({ "package.json": JSON.stringify({ scripts: { build: "webpack --mode production" } }) });
    const { spec } = await detectStack(files);
    expect(spec.resources).toEqual({});
  });

  test("no scripts.build at all → no site detected", async () => {
    const files = createMemoryFileTree({ "package.json": JSON.stringify({ dependencies: { express: "1" } }) });
    const { spec } = await detectStack(files);
    expect(spec.resources).toEqual({});
  });
});

test("Dockerfile ALWAYS wins over a static-build signal in the same directory", async () => {
  const files = createMemoryFileTree({
    Dockerfile: "x",
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "dist/index.html": "<html></html>",
  });
  const { spec, notes } = await detectStack(files);
  expect(spec.resources).toEqual({ app: { type: "app", dir: "." } });
  expect(spec.resources.site).toBeUndefined();
});

describe("monorepo (package.json workspaces, one level)", () => {
  test("trailing /* glob resolves member dirs; non-package candidates are filtered out", async () => {
    const files = createMemoryFileTree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/api/Dockerfile": "x",
      "packages/api/package.json": JSON.stringify({ dependencies: { pg: "1" } }),
      "packages/web/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "packages/web/dist/index.html": "<html></html>",
      "packages/docs/README.md": "not a package", // no package.json/Dockerfile → filtered
    });
    const { spec, notes } = await detectStack(files, { name: "myrepo" });
    expect(spec.name).toBe("myrepo");
    expect(spec.resources).toEqual({
      api: { type: "app", dir: "packages/api", uses: [{ database: "api-db" }] },
      "api-db": { type: "database" },
      web: { type: "site", dir: "packages/web/dist" },
    });
    expect(notes.some((n) => n.includes("monorepo: 2 workspace member"))).toBe(true);
    expect(notes.some((n) => n.includes('workspace candidate "packages/docs"'))).toBe(true);
  });

  test("literal (non-glob) workspace entries", async () => {
    const files = createMemoryFileTree({
      "package.json": JSON.stringify({ workspaces: ["backend", "frontend"] }),
      "backend/Dockerfile": "x",
      "frontend/package.json": JSON.stringify({ name: "frontend" }), // real package, but nothing detectable inside it
    });
    const { spec, notes } = await detectStack(files);
    expect(spec.resources).toEqual({ backend: { type: "app", dir: "backend" } });
    expect(spec.resources.frontend).toBeUndefined();
    expect(notes.some((n) => n.includes("frontend: no resource detected"))).toBe(true);
  });

  test("Yarn-style { packages: [...] } workspaces object", async () => {
    const files = createMemoryFileTree({
      "package.json": JSON.stringify({ workspaces: { packages: ["apps/*"] } }),
      "apps/svc/Dockerfile": "x",
    });
    const { spec } = await detectStack(files);
    expect(spec.resources.svc).toEqual({ type: "app", dir: "apps/svc" });
  });

  test("a root Dockerfile beats workspaces — treated as one app, not a monorepo", async () => {
    const files = createMemoryFileTree({
      Dockerfile: "x",
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/api/Dockerfile": "x",
    });
    const { spec, notes } = await detectStack(files);
    expect(spec.resources).toEqual({ app: { type: "app", dir: "." } });
    expect(notes.some((n) => n.includes("Dockerfile wins"))).toBe(true);
  });

  test("workspaces declared but nothing resolves to a real package → falls back to single-directory detection", async () => {
    // Deliberately no root Dockerfile here (that would short-circuit the monorepo check entirely via
    // the "Dockerfile always wins" rule, which is a different code path — see the test above).
    const files = createMemoryFileTree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"], scripts: { build: "vite build" } }),
      "packages/notes.txt": "just a file, no package dirs",
      "dist/index.html": "<html></html>",
    });
    const { spec, notes } = await detectStack(files);
    expect(spec.resources).toEqual({ site: { type: "site", dir: "dist" } });
    expect(notes.some((n) => n.includes("falling back to single-directory detection"))).toBe(true);
  });

  test("unsupported glob shapes are noted and skipped", async () => {
    const files = createMemoryFileTree({ "package.json": JSON.stringify({ workspaces: ["packages/**", "libs/*/src"] }) });
    const { notes } = await detectStack(files);
    expect(notes.some((n) => n.includes('unsupported workspace glob "packages/**"'))).toBe(true);
    expect(notes.some((n) => n.includes('unsupported workspace glob "libs/*/src"'))).toBe(true);
  });

  test("sanitizes non-DNS-safe member dirnames and disambiguates collisions", async () => {
    const files = createMemoryFileTree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/My_Cool App!/Dockerfile": "x",
      "packages/My-Cool-App/Dockerfile": "x", // sanitizes to the same key as above → collision
    });
    const { spec } = await detectStack(files);
    const keys = Object.keys(spec.resources).sort();
    expect(keys).toEqual(["my-cool-app", "my-cool-app-2"]);
  });
});

test("default stack name is 'app' when opts.name is omitted", async () => {
  const { spec } = await detectStack(createMemoryFileTree({}));
  expect(spec.name).toBe("app");
});

test("determinism: repeated detection of the same tree yields byte-identical resource key order", async () => {
  const files = createMemoryFileTree({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/zeta/Dockerfile": "x",
    "packages/alpha/Dockerfile": "x",
    "packages/mid/package.json": JSON.stringify({ dependencies: { pg: "1" } }), // no Dockerfile/build → no resource, still a real package
  });
  const r1 = await detectStack(files, { name: "x" });
  const r2 = await detectStack(files, { name: "x" });
  expect(Object.keys(r1.spec.resources)).toEqual(Object.keys(r2.spec.resources));
  expect(Object.keys(r1.spec.resources)).toEqual([...Object.keys(r1.spec.resources)].sort());
  expect(r1.spec).toEqual(r2.spec);
});

// ---------------------------------------------------------------------------------------------
// Fixture regression suite — every directory under examples/ (real filesystem), inline-asserted.
// This is the standing regression: every example must detect to exactly the spec below.
// ---------------------------------------------------------------------------------------------

const EXAMPLES_ROOT = resolve(import.meta.dir, "../../examples");

// The six container-app examples all follow the identical shape: a Dockerfile (→ app, dir ".") plus
// a `pg` dependency (→ a bound `database` resource), no build script/dist output, no Redis deps.
const APP_PLUS_DB = {
  app: { type: "app" as const, dir: ".", uses: [{ database: "db" }] },
  db: { type: "database" as const },
};

describe("examples/ fixture regression", () => {
  test.each([
    ["blog-express", APP_PLUS_DB],
    ["board-tanstack", APP_PLUS_DB], // has a Vite build script too, but its Dockerfile wins
    ["chat-ws", APP_PLUS_DB],
    ["guestbook-node", APP_PLUS_DB],
    ["notes-next", APP_PLUS_DB], // has a Next.js build script too, but its Dockerfile wins
    ["tasks-node-ts", APP_PLUS_DB],
    ["vite-react", { site: { type: "site" as const, dir: "dist" } }], // no Dockerfile; dist/index.html already built
    ["multipage", {}], // plain static HTML, no package.json/Dockerfile/dist → nothing to detect
    ["report", {}],
  ] as const)("examples/%s", async (name, expected) => {
    const tree = createFsFileTree(resolve(EXAMPLES_ROOT, name));
    const { spec } = await detectStack(tree, { name });
    expect(spec.resources).toEqual(expected as any);
  });
});
