// Per-STACK config, declared under the top-level `stack:` key in drop.yaml (sibling to
// `site:`/`app:`/`database:`). A stack is a declarative, multi-resource graph — the desired state for
// a group of sites/apps/databases plus the edges that wire them together. The API stores the sanitized
// spec as jsonb; the reconciler (`drop up`) diffs it against live state and converges. Unknown-key
// posture keeps old CLIs safe: an old `drop` that only knows `app:`/`site:` ignores `stack:` entirely.
//
// Design mirrors the per-type sanitizers (defensive, junk-ignoring, round-trip safe) and REUSES them
// where it can: an app resource is validated through `sanitizeAppConfig`, a database through
// `sanitizeDatabaseConfig`. Edges reference resource KEYS (not site names); the reconciler resolves a
// key to its materialized site name (`<stack>-<key>` unless the resource carries an explicit `name:`).
import { parse as parseYaml } from "yaml";
import { validateName } from "./names.ts";
import {
  sanitizeAppConfig,
  type AppService,
  type AppResources,
  type AppScale,
  type AppUse,
  type AppHealthcheck,
  type AppRelease,
  type AppProcess,
} from "./app-config.ts";
import { sanitizeDatabaseConfig, type Hibernation } from "./db-config.ts";
import { sanitizeCacheConfig } from "./cache-config.ts";
import { sanitizeAuthConfig, type AuthProvider, type AuthProviderKind, type SignupMode } from "./auth-config.ts";

export type StackResourceKind = "site" | "app" | "database" | "bucket" | "cache" | "auth";

/** A2 opt-in TCP exposure, carried in the spec (parsed + stored now; enforced by A2 later). */
export interface StackExpose {
  tcp: boolean;
}

/** A site→app edge: publish-time substitution of a referenced resource's output into the site bytes.
 *  `resource` is a resource KEY (must be an app); `output` is the output to read (v1: `url`); `as` is
 *  the `${as}` placeholder replaced in the site's text files at pack time (CLI-side, never server-side). */
export interface StackEnvFrom {
  resource: string; // resource KEY (app)
  output: "url"; // v1: the app's public URL
  as: string; // placeholder / env-var name substituted at pack time
}

/**
 * A single resource in a stack. A loose union of every resource type's fields (dispatched on `type`),
 * matching how the rest of the codebase models drop.yaml objects. Only the fields relevant to `type`
 * survive sanitization. Edges (`uses`, `env_from`) reference resource KEYS within the same stack.
 */
export interface StackResource {
  type: StackResourceKind;
  name?: string; // explicit site-name override (else `<stack>-<key>`)
  dir?: string; // CLI-side build/publish context (app image build, or site tarball); no bytes server-side
  env?: Record<string, string>;

  // --- app ---
  image?: string; // optional: a dir-based app's image is built+resolved by the CLI at `up` time
  services?: AppService[];
  resources?: AppResources;
  scale?: AppScale;
  trusted?: boolean;
  uses?: AppUse[]; // app→database edge; `database` is a resource KEY within the stack
  healthcheck?: AppHealthcheck;
  release?: AppRelease;
  processes?: Record<string, AppProcess>;
  expose?: StackExpose;

  // --- site ---
  env_from?: StackEnvFrom[]; // site→app edge (publish-time substitution)

  // --- database ---
  storage?: string;
  hibernation?: Hibernation;

  // --- cache (I2) ---
  memory?: string;
  persistent?: boolean;

  // --- auth (K1) --- (an auth resource binds to a database resource KEY via `db`)
  db?: string; // resource KEY of the database this auth resource's engine + users live in
  providers?: Partial<Record<AuthProviderKind, AuthProvider>>;
  redirect_urls?: string[];
  jwt_ttl?: string;
  signup?: SignupMode;
  site_url?: string;
  rbac?: boolean; // (K2) seed the app-RBAC schema + wire the GoTrue claims hook (see rbac-seed.ts)
}

export interface StackSpec {
  name: string;
  resources: Record<string, StackResource>;
}

const MAX_RESOURCES = 16; // v1 cap
const MAX_ENV_FROM = 16;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/; // an env-var / placeholder name
// A resource KEY is a short DNS label (1–32 chars). It is NOT a bare site name — it materializes as
// `<stack>-<key>` — so the site-name reserved-word list (which blocks e.g. "api"/"app") does NOT apply
// to keys; a key just has to be a valid label. An explicit `name:` override IS a site name and is
// validated with the stricter validateName (reserved words included) inside each per-type sanitizer.
const KEY_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

function str(v: unknown, max = 2048): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

function envMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const env: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "string") env[k] = val;
  return Object.keys(env).length ? env : undefined;
}

/** Sanitize an `app`-typed stack resource by REUSING `sanitizeAppConfig`. A dir-based app has no image
 *  yet (the CLI builds + resolves it at `up`), so we feed a sentinel image to satisfy the sanitizer,
 *  then strip it back off — the stored resource keeps `image` only when the author pinned one. `uses`
 *  entries carry resource KEYS here (valid DNS labels, so they pass sanitizeAppConfig's name check). */
function sanitizeApp(sub: Record<string, unknown>): StackResource | undefined {
  const hadImage = typeof sub.image === "string" && sub.image.length > 0;
  const a = sanitizeAppConfig({ ...sub, image: hadImage ? sub.image : "unbuilt:0" });
  if (!a) return undefined;
  const res: StackResource = { type: "app", services: a.services, resources: a.resources, trusted: a.trusted };
  if (hadImage) res.image = a.image;
  if (a.name) res.name = a.name;
  if (a.scale) res.scale = a.scale;
  if (a.env) res.env = a.env;
  if (a.uses) res.uses = a.uses;
  if (a.healthcheck) res.healthcheck = a.healthcheck;
  if (a.release) res.release = a.release;
  if (a.processes) res.processes = a.processes;
  const dir = str(sub.dir, 1024);
  if (dir) res.dir = dir;
  if (sub.expose && typeof sub.expose === "object") res.expose = { tcp: (sub.expose as Record<string, unknown>).tcp === true };
  return res;
}

/** Sanitize a `database`-typed stack resource by REUSING `sanitizeDatabaseConfig` (storage cap +
 *  hibernation defaults). Databases carry no content, so no `dir`/`env`. */
function sanitizeDb(sub: Record<string, unknown>): StackResource | undefined {
  const d = sanitizeDatabaseConfig(sub);
  if (!d) return undefined;
  const res: StackResource = { type: "database", storage: d.storage, hibernation: d.hibernation };
  if (d.name) res.name = d.name;
  return res;
}

/** Sanitize a `bucket`-typed stack resource (I1). A bucket carries no content — only an optional
 *  explicit name override; its prefix + creds are provisioned server-side and bound via `uses`. */
function sanitizeBucket(sub: Record<string, unknown>): StackResource {
  const res: StackResource = { type: "bucket" };
  const name = str(sub.name, 63);
  if (name && validateName(name) === null) res.name = name;
  return res;
}

/** Sanitize a `cache`-typed stack resource by REUSING `sanitizeCacheConfig` (memory clamp + persistent
 *  default). A cache carries no content, so no `dir`/`env`. */
function sanitizeCache(sub: Record<string, unknown>): StackResource | undefined {
  const cc = sanitizeCacheConfig(sub);
  if (!cc) return undefined;
  const res: StackResource = { type: "cache", memory: cc.memory, persistent: cc.persistent };
  if (cc.name && validateName(cc.name) === null) res.name = cc.name;
  return res;
}

/** Sanitize an `auth`-typed stack resource (K1) by REUSING sanitizeAuthConfig. It additionally carries
 *  a `db:` resource KEY naming the database its engine + users live in (validated as an edge below). */
function sanitizeAuth(sub: Record<string, unknown>): StackResource | undefined {
  const ac = sanitizeAuthConfig(sub);
  if (!ac) return undefined;
  const res: StackResource = { type: "auth", redirect_urls: ac.redirect_urls, jwt_ttl: ac.jwt_ttl, signup: ac.signup };
  if (ac.name && validateName(ac.name) === null) res.name = ac.name;
  if (ac.providers) res.providers = ac.providers;
  if (ac.site_url) res.site_url = ac.site_url;
  if (ac.rbac) res.rbac = true; // (K2) carry the RBAC flag through so the stack reconcile wires the hook
  const db = str(sub.db, 63);
  if (db) res.db = db;
  return res;
}

/** Sanitize a `site`-typed stack resource. Site routing config (redirects/headers/…) lives in the
 *  published bundle's OWN drop.yaml `site:` section — the stack spec carries only wiring: the build
 *  context (`dir`), a static `env`, and `env_from` edges (publish-time substitution from an app). */
function sanitizeSite(sub: Record<string, unknown>): StackResource {
  const res: StackResource = { type: "site" };
  const name = str(sub.name, 63);
  if (name && validateName(name) === null) res.name = name;
  const dir = str(sub.dir, 1024);
  if (dir) res.dir = dir;
  const env = envMap(sub.env);
  if (env) res.env = env;
  if (Array.isArray(sub.env_from)) {
    const out: StackEnvFrom[] = [];
    for (const e of (sub.env_from as unknown[]).slice(0, MAX_ENV_FROM)) {
      if (!e || typeof e !== "object") continue;
      const e2 = e as Record<string, unknown>;
      const resource = str(e2.resource, 63);
      const as = str(e2.as, 128);
      if (!resource || !as || !ENV_NAME_RE.test(as)) continue;
      if (e2.output !== "url") continue; // v1: only the app URL is a substitutable output
      out.push({ resource, output: "url", as });
    }
    if (out.length) res.env_from = out;
  }
  return res;
}

/**
 * Sanitize a parsed `stack:` object → StackSpec, or undefined when there's no valid name / no
 * resources. Junk-ignoring and round-trip safe: re-sanitizing a StackSpec yields the same StackSpec.
 * Structural only — cross-resource edge validation (targets exist, correct type) is `validateStackEdges`;
 * cycle detection is the planner's job (src/stacks/plan.ts).
 */
export function sanitizeStackConfig(input: unknown): StackSpec | undefined {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = str(raw.name, 63);
  if (!name || validateName(name) !== null) return undefined;
  if (!raw.resources || typeof raw.resources !== "object" || Array.isArray(raw.resources)) return undefined;

  const resources: Record<string, StackResource> = {};
  for (const [key, val] of Object.entries(raw.resources as Record<string, unknown>).slice(0, MAX_RESOURCES)) {
    if (!KEY_RE.test(key) || !val || typeof val !== "object") continue; // keys are short DNS labels
    const sub = val as Record<string, unknown>;
    const type = sub.type;
    let res: StackResource | undefined;
    if (type === "app") res = sanitizeApp(sub);
    else if (type === "database") res = sanitizeDb(sub);
    else if (type === "bucket") res = sanitizeBucket(sub);
    else if (type === "cache") res = sanitizeCache(sub);
    else if (type === "auth") res = sanitizeAuth(sub);
    else if (type === "site") res = sanitizeSite(sub);
    else continue; // unknown/absent type → ignore the entry
    if (res) resources[key] = res;
  }
  if (Object.keys(resources).length === 0) return undefined;
  return { name, resources };
}

/**
 * Validate the stack's edges STRUCTURALLY-across-resources: every app→{database,bucket,cache,auth,app}
 * (`uses`) target and site→app (`env_from`) target must be a resource KEY present in the same stack, of
 * the correct type. (H3) app→app is a `uses` edge like the others (injects `<KEY>_URL`); a static site
 * has no runtime env, so it carries NO `uses` (sanitizeSite drops it) — site→app stays `env_from` only.
 * Returns an error string (for a 400), or null when the edges are sound. Cycles are the planner's job.
 */
export function validateStackEdges(spec: StackSpec): string | null {
  for (const [key, res] of Object.entries(spec.resources)) {
    if (res.type === "app") {
      for (const u of res.uses ?? []) {
        if (u.database) {
          const t = spec.resources[u.database];
          if (!t) return `app "${key}" uses database "${u.database}", which is not a resource in this stack`;
          if (t.type !== "database") return `app "${key}" uses "${u.database}", which is a ${t.type}, not a database`;
        } else if (u.bucket) {
          const t = spec.resources[u.bucket];
          if (!t) return `app "${key}" uses bucket "${u.bucket}", which is not a resource in this stack`;
          if (t.type !== "bucket") return `app "${key}" uses "${u.bucket}", which is a ${t.type}, not a bucket`;
        } else if (u.cache) {
          const t = spec.resources[u.cache];
          if (!t) return `app "${key}" uses cache "${u.cache}", which is not a resource in this stack`;
          if (t.type !== "cache") return `app "${key}" uses "${u.cache}", which is a ${t.type}, not a cache`;
        } else if (u.auth) {
          const t = spec.resources[u.auth];
          if (!t) return `app "${key}" uses auth "${u.auth}", which is not a resource in this stack`;
          if (t.type !== "auth") return `app "${key}" uses "${u.auth}", which is a ${t.type}, not an auth resource`;
        } else if (u.app) {
          // (H3) app→app service discovery: the target must be another app resource in the same stack.
          // The consumer gets a `<KEY>_URL` env at reconcile (see applyAppResource). A cycle (a↔b) is the
          // planner's job to reject (topoOrder), not this structural check.
          const t = spec.resources[u.app];
          if (!t) return `app "${key}" uses app "${u.app}", which is not a resource in this stack`;
          if (t.type !== "app") return `app "${key}" uses "${u.app}", which is a ${t.type}, not an app`;
        }
      }
    } else if (res.type === "auth") {
      // (K1) An auth resource requires a `db:` naming a database resource in the same stack — its engine
      // + users live in that Postgres. A missing/mistyped `db` is a hard 400 (no default: auth without a
      // database is meaningless).
      if (!res.db) return `auth "${key}" must declare a "db" (a database resource in this stack for its users)`;
      const t = spec.resources[res.db];
      if (!t) return `auth "${key}" uses db "${res.db}", which is not a resource in this stack`;
      if (t.type !== "database") return `auth "${key}" uses "${res.db}", which is a ${t.type}, not a database`;
    } else if (res.type === "site") {
      for (const e of res.env_from ?? []) {
        const t = spec.resources[e.resource];
        if (!t) return `site "${key}" reads env_from "${e.resource}", which is not a resource in this stack`;
        if (t.type !== "app") return `site "${key}" reads env_from "${e.resource}", which is a ${t.type}, not an app`;
      }
    }
  }
  return null;
}

/** The materialized site name for a resource: its explicit `name:`, else `<stack>-<key>`. The single
 *  authority for key→name; `stack_resources.resource_key → site_name` records the result. */
export function resolveResourceName(stackName: string, key: string, res: StackResource): string {
  return res.name ?? `${stackName}-${key}`;
}

/** Parse a `drop.yaml` body and return its `stack:` section, or undefined if absent/invalid. */
export function parseStackConfig(text: string): StackSpec | undefined {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  const stack = doc && typeof doc === "object" ? (doc as Record<string, unknown>).stack : undefined;
  return sanitizeStackConfig(stack);
}
