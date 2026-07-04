// `drop detect` (F1) — pure local heuristics that propose a `stack:` section from what's already on
// disk: no server call, no network, no guessing beyond what the plan enumerates. This module is the
// PURE core: it never touches the real filesystem — callers inject a `FileTree` (the CLI wires one to
// `node:fs`; tests wire an in-memory one) so every heuristic is table-testable without IO.
//
// Heuristics (mirrors Plan-v5.md F1):
//   - a `Dockerfile` (any casing) in a directory → an `app` resource (`dir:` that directory).
//   - Postgres signals (a `prisma/` dir; `pg`/`postgres`/`postgres.js`/`drizzle-orm` in package.json
//     deps; `PG*`/`DATABASE_URL` in `.env.example`) → a `database` resource + `uses: [{ database }]`
//     on the app in that SAME directory (no app in the directory → nothing to bind the DB to, so no
//     database resource is emitted — see analyzeDir).
//   - Redis signals (`ioredis`/`redis`/`bullmq` deps; `REDIS_URL` in `.env.example`) → a `cache`
//     resource + `uses: [{ cache }]`, same "only if there's an app to bind it to" rule.
//   - Static build (only when there's NO Dockerfile in the directory — a Dockerfile always wins, since
//     a containerized app's own build stage already produces its bytes): a `dist/index.html` that
//     already exists is the strongest signal (dir: "dist"); otherwise a package.json `scripts.build`
//     string mentioning the literal word "dist", "out" or "build" (checked in that priority order,
//     because "build" alone is the weakest signal — nearly every bundler's build script contains the
//     word "build" as the command name, not necessarily the output folder) → a `site` resource with
//     that directory.
//   - Monorepo: package.json `workspaces` (array form, or Yarn's `{ packages: [...] }`) resolved ONE
//     level (literal paths, or a single trailing `/*` glob segment) to candidate directories, kept only
//     when the candidate has its own `package.json`/`Dockerfile` (so a glob matching a non-package
//     folder like `packages/README` doesn't become a bogus resource) — each surviving member is
//     analyzed with the exact same single-directory heuristics above, keyed by its sanitized dirname.
//     A root-level Dockerfile beats `workspaces` (same "Dockerfile always wins" rule, one level up).
//
// Deterministic: resource keys are sorted before being returned, so the same input always serializes
// identically (stable naming; no reliance on object insertion order or directory listing order).
import type { AppUse } from "../app-config.ts";
import type { StackResource } from "../stack-config.ts";

export interface FileTreeEntry {
  name: string;
  isDir: boolean;
}

/** The read abstraction detectStack runs against. `dir` is a POSIX-style path relative to the tree's
 *  root ("" is the root itself); `list` returns [] for a missing directory (never throws). `read`
 *  returns undefined for a missing/unreadable file (never throws). */
export interface FileTree {
  list(dir: string): Promise<FileTreeEntry[]>;
  read(path: string): Promise<string | undefined>;
}

export interface DetectedSpec {
  name: string;
  resources: Record<string, StackResource>;
}

export interface DetectResult {
  spec: DetectedSpec;
  notes: string[];
}

const KEY_MAX = 32; // matches stack-config.ts's KEY_RE cap (a resource key is a short DNS label)

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Turn arbitrary text into a DNS-safe label body (lowercase, `[a-z0-9-]`, no leading/trailing `-`,
 *  capped at KEY_MAX) — NOT yet guaranteed unique; see uniqueKey. */
function slugify(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > KEY_MAX) s = s.slice(0, KEY_MAX).replace(/-+$/g, "");
  return s;
}

/** A unique, DNS-safe resource key derived from `raw` (a directory name, or a derived string like
 *  `"<member>-db"`), disambiguated against `used` with a numeric suffix on collision. Mutates `used`. */
function uniqueKey(raw: string, used: Set<string>, fallback = "pkg"): string {
  const base = slugify(raw) || fallback;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = `-${n++}`;
    candidate = (base.length + suffix.length > KEY_MAX ? base.slice(0, KEY_MAX - suffix.length) : base) + suffix;
  }
  used.add(candidate);
  return candidate;
}

async function readPackageJson(files: FileTree, dir: string): Promise<Record<string, any> | undefined> {
  const text = await files.read(joinRel(dir, "package.json"));
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function depNames(pkg: Record<string, any> | undefined): Set<string> {
  const out = new Set<string>();
  if (!pkg) return out;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object") for (const k of Object.keys(deps)) out.add(k);
  }
  return out;
}

const POSTGRES_DEPS = ["pg", "postgres", "postgres.js", "drizzle-orm"];
const REDIS_DEPS = ["ioredis", "redis", "bullmq"];
// Priority order for the build-script keyword scan — "dist" and "out" are specific (usually literally
// the output directory); "build" is the weakest signal since it's often just the command name (e.g.
// "vite build", "next build") rather than a folder reference.
const BUILD_DIR_TOKENS = ["dist", "out", "build"] as const;

interface DirAnalysis {
  kind: "app" | "site" | "none";
  siteDir?: string; // set when kind === "site"
  needsDb: boolean;
  needsCache: boolean;
  notes: string[];
}

/** Analyze ONE directory in isolation (no recursion) against every per-directory heuristic. `label` is
 *  used only in note text (the resource key this directory will become). */
async function analyzeDir(files: FileTree, dir: string, label: string): Promise<DirAnalysis> {
  const notes: string[] = [];
  const where = dir === "" ? "." : dir;
  const entries = await files.list(dir);
  const hasDockerfile = entries.some((e) => !e.isDir && e.name.toLowerCase() === "dockerfile");
  const hasPrisma = entries.some((e) => e.isDir && e.name === "prisma");

  const pkg = await readPackageJson(files, dir);
  const deps = depNames(pkg);
  const pgDep = POSTGRES_DEPS.find((d) => deps.has(d));
  const redisDep = REDIS_DEPS.find((d) => deps.has(d));

  const envExample = await files.read(joinRel(dir, ".env.example"));
  const envHasPg = !!envExample && (/^PG[A-Z_]*=/m.test(envExample) || /^DATABASE_URL=/m.test(envExample));
  const envHasRedis = !!envExample && /^REDIS_URL=/m.test(envExample);

  const needsDb = hasPrisma || !!pgDep || envHasPg;
  const needsCache = !!redisDep || envHasRedis;
  const dbSignal = hasPrisma ? "a prisma/ directory" : pgDep ? `"${pgDep}" in package.json deps` : "PG*/DATABASE_URL in .env.example";
  const cacheSignal = redisDep ? `"${redisDep}" in package.json deps` : "REDIS_URL in .env.example";

  if (hasDockerfile) {
    notes.push(`${where}: Dockerfile → ${label} resource (dir: ${where})`);
    if (needsDb) notes.push(`${where}: ${dbSignal} → database resource + uses binding on ${label}`);
    if (needsCache) notes.push(`${where}: ${cacheSignal} → cache resource + uses binding on ${label}`);
    return { kind: "app", needsDb, needsCache, notes };
  }

  // Static build — only considered when there's no Dockerfile (see module doc).
  const distIndex = await files.read(joinRel(dir, "dist/index.html"));
  let siteDir: string | undefined;
  if (distIndex !== undefined) {
    siteDir = "dist";
    notes.push(`${where}: dist/index.html exists → site resource (dir: dist)`);
  } else {
    const buildScript = typeof pkg?.scripts?.build === "string" ? (pkg.scripts.build as string) : undefined;
    if (buildScript) {
      const token = BUILD_DIR_TOKENS.find((t) => new RegExp(`\\b${t}\\b`).test(buildScript));
      if (token) {
        siteDir = token;
        notes.push(`${where}: package.json build script (${JSON.stringify(buildScript)}) mentions "${token}" → site resource (dir: ${token})`);
      }
    }
  }

  if (siteDir) {
    if (needsDb || needsCache) notes.push(`${where}: database/cache signal(s) found but this is a static site — skipped (a site has no uses:)`);
    return { kind: "site", siteDir, needsDb: false, needsCache: false, notes };
  }

  if (needsDb) notes.push(`${where}: ${dbSignal} found but no Dockerfile/app here to bind it to — skipped`);
  if (needsCache) notes.push(`${where}: ${cacheSignal} found but no Dockerfile/app here to bind it to — skipped`);
  if (!needsDb && !needsCache) notes.push(`${where}: no resource detected`);
  return { kind: "none", needsDb: false, needsCache: false, notes };
}

function extractWorkspaceGlobs(pkg: Record<string, any> | undefined): string[] {
  if (!pkg) return [];
  const raw = pkg.workspaces;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (raw && typeof raw === "object" && Array.isArray(raw.packages)) {
    return (raw.packages as unknown[]).filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** Resolve `workspaces` globs ONE level: a literal path is used as-is; a pattern ending in exactly
 *  `/*` lists that directory's immediate subdirectories. Anything else is unsupported (noted, skipped)
 *  — this is a bounded "one level of workspace walk", not a general glob engine. */
async function resolveWorkspaceMembers(files: FileTree, globs: string[], notes: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const g of globs) {
    if (!g.includes("*")) {
      out.add(g.replace(/\/+$/, ""));
      continue;
    }
    const m = /^(.*)\/\*$/.exec(g);
    if (!m) {
      notes.push(`unsupported workspace glob "${g}" — only a literal path or a trailing /* is supported; skipped`);
      continue;
    }
    const prefix = m[1]!;
    const entries = await files.list(prefix);
    for (const e of entries) if (e.isDir) out.add(`${prefix}/${e.name}`);
  }
  return [...out].sort();
}

async function isRealPackage(files: FileTree, dir: string): Promise<boolean> {
  const entries = await files.list(dir);
  return entries.some((e) => !e.isDir && (e.name.toLowerCase() === "dockerfile" || e.name === "package.json"));
}

/** Build the `app` resource (+ its bound database/cache resources, if any) for a directory whose
 *  analysis came back `kind: "app"`, writing into `resources`/`used` in place. `dbKey`/`cacheKey` name
 *  the bound resources (fixed "db"/"cache" at the root; derived per-member in a monorepo). */
function addAppResource(
  resources: Record<string, StackResource>,
  key: string,
  dir: string,
  a: DirAnalysis,
  dbKey: string,
  cacheKey: string,
): void {
  const res: StackResource = { type: "app", dir };
  const uses: AppUse[] = [];
  if (a.needsDb) {
    resources[dbKey] = { type: "database" };
    uses.push({ database: dbKey });
  }
  if (a.needsCache) {
    resources[cacheKey] = { type: "cache" };
    uses.push({ cache: cacheKey });
  }
  if (uses.length) res.uses = uses;
  resources[key] = res;
}

/**
 * Detect a proposed `stack:` spec from `files`. Deterministic: the same tree always yields the same
 * spec (sorted resource keys, stable derived naming). `opts.name` sets the proposed stack name (the
 * CLI/MCP pass the target directory's sanitized basename); defaults to "app".
 */
export async function detectStack(files: FileTree, opts: { name?: string } = {}): Promise<DetectResult> {
  const notes: string[] = [];
  const name = opts.name ?? "app";

  const rootEntries = await files.list("");
  const rootHasDockerfile = rootEntries.some((e) => !e.isDir && e.name.toLowerCase() === "dockerfile");
  const rootPkg = await readPackageJson(files, "");
  let workspaceGlobs = extractWorkspaceGlobs(rootPkg);
  if (workspaceGlobs.length > 0 && rootHasDockerfile) {
    notes.push(`root has both a Dockerfile and package.json "workspaces" — Dockerfile wins; treating the root as a single app, not a monorepo`);
    workspaceGlobs = [];
  }

  if (workspaceGlobs.length > 0) {
    const memberDirs = await resolveWorkspaceMembers(files, workspaceGlobs, notes);
    const real: string[] = [];
    for (const m of memberDirs) {
      if (await isRealPackage(files, m)) real.push(m);
      else notes.push(`workspace candidate "${m}" has no package.json/Dockerfile of its own — skipped`);
    }
    if (real.length > 0) {
      const resources: Record<string, StackResource> = {};
      const used = new Set<string>();
      notes.push(`monorepo: ${real.length} workspace member(s) detected — ${real.map((r) => r.split("/").pop()).join(", ")}`);
      for (const m of real) {
        const base = m.split("/").pop()!;
        const key = uniqueKey(base, used);
        const a = await analyzeDir(files, m, key);
        notes.push(...a.notes);
        if (a.kind === "app") {
          addAppResource(resources, key, m, a, uniqueKey(`${key}-db`, used), uniqueKey(`${key}-cache`, used));
        } else if (a.kind === "site") {
          resources[key] = { type: "site", dir: `${m}/${a.siteDir}` };
        }
      }
      return finish(name, resources, notes);
    }
    notes.push(`package.json declares "workspaces" but no member matched a real package — falling back to single-directory detection`);
  }

  const resources: Record<string, StackResource> = {};
  const a = await analyzeDir(files, "", "app");
  notes.push(...a.notes);
  if (a.kind === "app") {
    addAppResource(resources, "app", ".", a, "db", "cache");
  } else if (a.kind === "site") {
    resources["site"] = { type: "site", dir: a.siteDir! };
  }

  return finish(name, resources, notes);
}

function finish(name: string, resources: Record<string, StackResource>, notes: string[]): DetectResult {
  const sorted: Record<string, StackResource> = {};
  for (const k of Object.keys(resources).sort()) sorted[k] = resources[k]!;
  return { spec: { name, resources: sorted }, notes };
}

/** An in-memory FileTree for table tests: keys are POSIX-style relative file paths (no leading "./"),
 *  values are their text content — directories are inferred from path segments, no need to declare
 *  them separately. e.g. `{ "Dockerfile": "...", "prisma/schema.prisma": "..." }` lists a "prisma"
 *  directory at the root. */
export function createMemoryFileTree(fileContents: Record<string, string>): FileTree {
  const files = new Map(Object.entries(fileContents));
  return {
    async read(path: string) {
      return files.get(path);
    },
    async list(dir: string) {
      const prefix = dir ? `${dir}/` : "";
      const seen = new Map<string, boolean>(); // name -> isDir
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf("/");
        if (slash === -1) seen.set(rest, false);
        else seen.set(rest.slice(0, slash), true);
      }
      return [...seen.entries()].map(([entryName, isDir]) => ({ name: entryName, isDir }));
    },
  };
}
