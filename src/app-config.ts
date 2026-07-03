// Per-app config, declared under `app:` in drop.yaml (sibling to `site:`). Parsed
// at deploy time; the API translates it into Kubernetes objects. v1 is 443-only:
// exactly one HTTP service on the wildcard host. Raw TCP / multi-port is deferred
// (the `services` list is modelled now so v2 is additive).
import { parse as parseYaml } from "yaml";
import { validateName } from "./names.ts";

export interface AppService {
  internalPort: number;
  protocol: "http" | "tcp";
}
export interface AppResources {
  cpu?: string; // e.g. "0.5", "500m"
  memory?: string; // e.g. "512Mi"
}
export interface AppScale {
  min: number; // KEDA minReplicaCount (0 = scale-to-zero)
  max: number; // KEDA maxReplicaCount
}
export interface AppUse {
  database: string; // a managed database in the SAME org; deploy wires envFrom <db>-app + CA + verify-full
}
// Readiness + liveness probes on the web container. All fields are RESOLVED seconds (the sanitizer
// parses "10s"/"2m" durations, applies defaults, and clamps to bounds) so the manifest layer just
// reads them. Same endpoint drives both probes by default; readiness gates traffic, liveness
// restarts a wedged pod. Absent → a TCP-socket readiness probe on the container port (see manifests).
export interface AppHealthcheck {
  path: string; // HTTP path, must start with "/" (else the block is dropped → default TCP probe)
  interval?: number; // periodSeconds; 1–300, default 10
  timeout?: number; // timeoutSeconds; 1–60, default 2
  grace?: number; // initialDelaySeconds; 0–600, default 15
}
// A pre-rollout release phase: a Kubernetes Job (same image/env/bindings/secrets as the app) run
// BEFORE the new Deployment is applied. Failure halts the deploy — the old version keeps serving.
export interface AppRelease {
  command: string; // shell-form command, e.g. "npm run migrate" → ["/bin/sh","-c",command]
  timeout?: number; // seconds; 1–900 (15m cap), default 300 (5m)
}
// A named process. The map key `web` (or web:true) marks THE web process — Service + HTTPScaledObject;
// every other process is a plain worker Deployment. All processes share image/env/secrets/bindings.
export interface AppProcess {
  command?: string | string[]; // string → shell-form ["/bin/sh","-c",cmd]; array → exec-form passthrough
  scale?: AppScale; // web: KEDA bounds; worker: static replicas (min≥1 enforced at expand time)
  resources?: AppResources; // overrides the app-level default for this process
  web?: boolean; // explicit web marker (the `web` key defaults to true; any other key to false)
  scaleOn?: { queue: string; target: number }; // RESERVED for L1b (queue-scaled workers); round-trips, IGNORED by manifests today
}
export interface AppConfig {
  name?: string;
  image: string;
  resources?: AppResources;
  env?: Record<string, string>;
  services: AppService[];
  scale?: AppScale;
  trusted?: boolean; // default true (no sandbox); false opts into the gVisor RuntimeClass (prod)
  uses?: AppUse[]; // first-class DB binding: `uses: [{ database: <name> }]` (omitted when none declared)
  healthcheck?: AppHealthcheck; // readiness/liveness probes on the web container (omitted → default TCP readiness)
  release?: AppRelease; // pre-rollout migration Job (omitted → no release phase)
  processes?: Record<string, AppProcess>; // multi-process apps (omitted → today's implicit single web process)
}

const DEFAULT_SERVICE: AppService = { internalPort: 8080, protocol: "http" };
const DEFAULT_RESOURCES: AppResources = { cpu: "0.5", memory: "512Mi" };
const DEFAULT_APP_SCALE: AppScale = { min: 0, max: 3 }; // web default (matches the manifest layer)
const RELEASE_DEFAULT_TIMEOUT_S = 300; // 5m
const RELEASE_MAX_TIMEOUT_S = 900; // 15m cap

function str(v: unknown, max = 2048): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** Parse a duration to whole seconds: a number is seconds; "10s"/"2m"/"1h" are scaled. Junk → undefined. */
function parseSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === "string") {
    const m = /^(\d+)\s*(s|m|h)?$/.exec(v.trim());
    if (!m) return undefined;
    const mult = m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
    return parseInt(m[1]!, 10) * mult;
  }
  return undefined;
}

/** Parse a duration then clamp to [min,max]; junk (or absent) → def. Defensive, never throws. */
function boundedSeconds(v: unknown, min: number, max: number, def: number): number {
  const s = parseSeconds(v);
  if (s === undefined) return def;
  return Math.min(max, Math.max(min, s));
}

function sanitizeScale(v: unknown): AppScale | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const min = typeof s.min === "number" && s.min >= 0 ? s.min : undefined;
  const max = typeof s.max === "number" && s.max >= 1 ? s.max : undefined;
  return min != null && max != null && max >= min ? { min, max } : undefined;
}

function sanitizeResources(v: unknown): AppResources | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const cpu = str(r.cpu, 32);
  const memory = str(r.memory, 32);
  return cpu || memory ? { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) } : undefined;
}

/** Sanitize a parsed `app:` object → AppConfig, or undefined when there's no valid image. */
export function sanitizeAppConfig(input: unknown): AppConfig | undefined {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const image = str(raw.image, 512);
  if (!image) return undefined;

  const cfg: AppConfig = { image, services: [] };

  const name = str(raw.name, 63);
  if (name && validateName(name) === null) cfg.name = name;

  cfg.resources = sanitizeResources(raw.resources) ?? { ...DEFAULT_RESOURCES }; // never unbounded (LIM-1)
  cfg.trusted = raw.trusted !== false; // default true; explicit false opts into the sandbox

  if (raw.env && typeof raw.env === "object") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) if (typeof v === "string") env[k] = v;
    if (Object.keys(env).length) cfg.env = env;
  }

  if (Array.isArray(raw.services)) {
    for (const s of (raw.services as any[]).slice(0, 16)) {
      // accept drop.yaml's `internal_port` AND the already-sanitized `internalPort`
      // so re-sanitizing an AppConfig (CLI -> JSON -> API) is round-trip safe.
      const port =
        typeof s?.internal_port === "number" ? s.internal_port : typeof s?.internalPort === "number" ? s.internalPort : undefined;
      if (port == null || port < 1 || port > 65535) continue;
      cfg.services.push({ internalPort: port, protocol: s?.protocol === "tcp" ? "tcp" : "http" });
    }
  }
  if (cfg.services.length === 0) cfg.services = [{ ...DEFAULT_SERVICE }];

  cfg.scale = sanitizeScale(raw.scale);

  // `uses` declares dependencies on managed resources (v1: databases). Each entry is
  // `{ database: <name> }`; the deploy path resolves the name to a same-org database and
  // wires the app to its CNPG `<db>-app` Secret + cluster CA + PGSSLMODE=verify-full. Same
  // defensive posture as everything above: ignore non-array input and junk entries, require a
  // valid workload name, collapse duplicates, and cap the list. Round-trip safe — the sanitized
  // shape `{ database: <name> }` re-sanitizes unchanged (CLI -> JSON -> API).
  if (Array.isArray(raw.uses)) {
    const uses: AppUse[] = [];
    const seen = new Set<string>();
    for (const u of (raw.uses as any[]).slice(0, 8)) {
      const database = str(u?.database, 63);
      if (!database || validateName(database) !== null || seen.has(database)) continue;
      seen.add(database);
      uses.push({ database });
    }
    if (uses.length) cfg.uses = uses;
  }

  // `healthcheck` → readiness + liveness probes on the web container. Durations are parsed and
  // clamped defensively (junk → the default); an absent/relative path drops the block entirely, so
  // the manifest layer falls back to a TCP-socket readiness probe. Sanitized to RESOLVED seconds so
  // it re-sanitizes unchanged (CLI -> JSON -> API).
  if (raw.healthcheck && typeof raw.healthcheck === "object") {
    const h = raw.healthcheck as Record<string, unknown>;
    const path = str(h.path, 256);
    if (path && path.startsWith("/")) {
      cfg.healthcheck = {
        path,
        interval: boundedSeconds(h.interval, 1, 300, 10),
        timeout: boundedSeconds(h.timeout, 1, 60, 2),
        grace: boundedSeconds(h.grace, 0, 600, 15),
      };
    }
  }

  // `release` → a pre-rollout migration Job. Accept the shorthand `release: "<cmd>"` and the object
  // form `{ command, timeout? }`. Timeout is clamped to ≤15m (default 5m). No command → no release.
  const releaseRaw = typeof raw.release === "string" ? { command: raw.release } : raw.release;
  if (releaseRaw && typeof releaseRaw === "object") {
    const command = str((releaseRaw as Record<string, unknown>).command, 4096);
    if (command) {
      cfg.release = {
        command,
        timeout: boundedSeconds((releaseRaw as Record<string, unknown>).timeout, 1, RELEASE_MAX_TIMEOUT_S, RELEASE_DEFAULT_TIMEOUT_S),
      };
    }
  }

  // `processes` → a map of named processes replacing the implicit single web process. Each key must
  // be a DNS-safe name (it becomes `<app>-<key>` for workers). Same defensive posture: ignore junk
  // entries/values, cap the map, and re-sanitize unchanged. `scale_on` is RESERVED for L1b (queue
  // scaling) — accepted and round-tripped here, but IGNORED by the manifest layer today. Web
  // uniqueness (at most one web process) is enforced at deploy via assertProcesses, not dropped here.
  if (raw.processes && typeof raw.processes === "object" && !Array.isArray(raw.processes)) {
    const procs: Record<string, AppProcess> = {};
    for (const [key, val] of Object.entries(raw.processes as Record<string, unknown>).slice(0, 16)) {
      if (validateName(key) !== null || !val || typeof val !== "object") continue;
      const p = val as Record<string, unknown>;
      const proc: AppProcess = {};
      if (typeof p.command === "string" && p.command.length > 0 && p.command.length <= 4096) proc.command = p.command;
      else if (Array.isArray(p.command)) {
        const arr = (p.command as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 4096);
        if (arr.length) proc.command = arr;
      }
      const scale = sanitizeScale(p.scale);
      if (scale) proc.scale = scale;
      const resources = sanitizeResources(p.resources);
      if (resources) proc.resources = resources;
      if (typeof p.web === "boolean") proc.web = p.web;
      // accept drop.yaml's `scale_on` AND the sanitized `scaleOn` (round-trip safety)
      const so = (p.scale_on ?? p.scaleOn) as Record<string, unknown> | undefined;
      if (so && typeof so === "object") {
        const queue = str(so.queue, 253);
        const target = typeof so.target === "number" && so.target >= 1 ? Math.floor(so.target) : undefined;
        if (queue && target != null) proc.scaleOn = { queue, target };
      }
      procs[key] = proc;
    }
    if (Object.keys(procs).length) cfg.processes = procs;
  }

  return cfg;
}

/** A process is the "web" process (Service + HTTPScaledObject) iff its key is `web` (unless
 *  web:false) OR it explicitly sets web:true. Everything else is a plain worker Deployment. */
export function isWebProcess(key: string, p: AppProcess): boolean {
  return key === "web" ? p.web !== false : p.web === true;
}

/**
 * At most one web process is allowed (which one gets the Service/host must be unambiguous). Absent
 * `processes:` is always fine (an implicit single web). More than one web → deploy 400s — the loud,
 * defensive option over silently dropping a process the author declared.
 */
export function assertProcesses(app: AppConfig): void {
  if (!app.processes) return;
  const webs = Object.entries(app.processes).filter(([k, p]) => isWebProcess(k, p));
  if (webs.length > 1) {
    throw new Error(`an app may declare at most one "web" process; got ${webs.length} (${webs.map(([k]) => k).join(", ")})`);
  }
}

/** A fully-resolved process (deployment name, web flag, scale, resources), ready for the manifest
 *  layer. Absent `processes:` yields exactly one implicit web process — today's single-process app. */
export interface ExpandedProcess {
  name: string; // Deployment name: `<app>` for web, `<app>-<key>` for a worker
  process: string; // the process key ("web" for the implicit process)
  web: boolean; // gets Service + HTTPScaledObject; workers get a plain Deployment
  command?: string | string[];
  scale: AppScale; // web: KEDA bounds; worker: static replicas (min≥1)
  resources?: AppResources;
  scaleOn?: { queue: string; target: number }; // RESERVED for L1b; ignored by manifests today
}

/** Expand an AppConfig into its concrete processes. Workers get min≥1 static scale (a scale-to-zero
 *  worker has no wake source, so it would never run). Per-process resources/scale override the
 *  app-level defaults; command is per-process only. */
export function expandProcesses(app: AppConfig, appName: string): ExpandedProcess[] {
  if (!app.processes) {
    return [{ name: appName, process: "web", web: true, scale: app.scale ?? { ...DEFAULT_APP_SCALE }, resources: app.resources }];
  }
  const out: ExpandedProcess[] = [];
  for (const [key, p] of Object.entries(app.processes)) {
    if (isWebProcess(key, p)) {
      out.push({
        name: appName,
        process: key,
        web: true,
        command: p.command,
        scale: p.scale ?? app.scale ?? { ...DEFAULT_APP_SCALE },
        resources: p.resources ?? app.resources,
        scaleOn: p.scaleOn,
      });
    } else {
      // Workers are static (no HTTPScaledObject in L1): replicas = min, min≥1. `max` + `scaleOn`
      // are carried through but only activate under L1b (KEDA queue scaling).
      const min = Math.max(1, p.scale?.min ?? 1);
      const max = Math.max(min, p.scale?.max ?? 1);
      out.push({
        name: `${appName}-${key}`,
        process: key,
        web: false,
        command: p.command,
        scale: { min, max },
        resources: p.resources ?? app.resources,
        scaleOn: p.scaleOn,
      });
    }
  }
  return out;
}

/** Parse a `drop.yaml` body and return its `app:` section, or undefined if absent/invalid. */
export function parseAppConfig(text: string): AppConfig | undefined {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  const app = doc && typeof doc === "object" ? (doc as Record<string, unknown>).app : undefined;
  return sanitizeAppConfig(app);
}

/**
 * v1 is 443-only: an app exposes exactly one HTTP service on the wildcard host.
 * Raw TCP / multi-port is deferred to v2; reject it explicitly rather than silently.
 */
export function assertHttpOnly(app: AppConfig): void {
  if (app.services.length !== 1) {
    throw new Error(
      `v1 supports exactly one service per app; got ${app.services.length} (raw TCP / multi-port is not yet supported)`,
    );
  }
  if (app.services[0]!.protocol !== "http") {
    throw new Error("v1 supports only protocol: http (raw TCP is not yet supported)");
  }
}
