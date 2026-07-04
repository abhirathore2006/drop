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
  database?: string; // a managed database in the SAME org; deploy wires envFrom <db>-app + CA + verify-full
  bucket?: string; // (I1) a tenant bucket in the SAME org; deploy injects S3_* creds via the write-only secret path
  cache?: string; // (I2) a managed cache (Valkey) in the SAME org; deploy injects REDIS_URL via the write-only secret path
  auth?: string; // (K1) a managed auth resource in the SAME org; deploy injects AUTH_URL + AUTH_JWT_SECRET (write-only path)
  app?: string; // (H3) another app in the SAME org + namespace (service discovery); deploy injects <KEY>_URL — a PLAIN, non-secret container env (see appUseUrl in kube/manifests.ts)
  via?: "pooler"; // (I3) database bindings ONLY: route the injected PGHOST at the CNPG Pooler service (needs the DB's pooler enabled)
}
// Readiness + liveness probes on the web container. All fields are RESOLVED seconds (the sanitizer
// parses "10s"/"2m" durations, applies defaults, and clamps to bounds) so the manifest layer just
// reads them. Same endpoint drives both probes by default; readiness gates traffic, liveness
// restarts a wedged pod. Absent → a TCP-socket readiness probe on the container port (see manifests).
export interface AppHealthcheck {
  path?: string; // HTTP path, must start with "/" (else no HTTP probe → default TCP probe)
  interval?: number; // periodSeconds; 1–300, default 10
  timeout?: number; // timeoutSeconds; 1–60, default 2
  grace?: number; // initialDelaySeconds; 0–600, default 15
  // (G2b) Opt-in: keep this app warm enough to be uptime-probed even when it can scale to zero. A
  // scale-to-zero app is NOT probed by default (a probe would wake the pod); set keep_warm to accept
  // that cost in exchange for proactive uptime data. Purely an observability signal — it does NOT
  // change the KEDA scale bounds (min stays 0), so the pod still scales down between probes/traffic.
  keepWarm?: boolean;
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
  // (L1b) Queue-scaled worker config: emits a KEDA `ScaledObject` (redis-lists trigger) pointed at
  // the app's bound Valkey cache, alongside this worker's Deployment. Valid ONLY on a non-web process
  // (assertProcesses rejects it on web) whose app has at least one `{cache}` binding in `uses`
  // (assertProcesses rejects it otherwise) — the queue lives in that cache. `target` is clamped to
  // [1,1000] at sanitize time (see the `processes` loop below).
  scaleOn?: { queue: string; target: number };
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
  // (H2) A 5-field cron expression ("min hour dom month dow") turning this app into a CronJob instead
  // of a Deployment+HTTPScaledObject — ends the "worker fronted by HTTP just to keep it alive" hack.
  // Mutually exclusive with `processes`, an explicitly-declared `services`, and `healthcheck` (probes
  // are meaningless on a one-shot Job) — enforced in assertProcesses, not here. `scale` is ignored: a
  // CronJob has no HPA/KEDA target. `release:` is UNAFFECTED — it still runs, unchanged, before every
  // deploy of the CronJob object (not before each scheduled fire).
  schedule?: string;
  // (H2) The CronJob's command: a string runs in shell form (["/bin/sh","-c",cmd]); an array is
  // exec-form passthrough — same convention as AppProcess.command. Omitted → the image's own
  // entrypoint. Only meaningful when `schedule` is set; sanitized unconditionally regardless (a
  // harmless no-op field otherwise).
  command?: string | string[];
  // (I5) Opt-in constrained volume: `stateful: { volume: "2Gi", mount: "/data" }` (or the shorthand
  // `stateful: true` for the defaults). Forces the web process to an always-on, single-replica
  // Deployment (scale: {min:1,max:1} — validated/clamped in assertProcesses/expandProcesses) with
  // strategy: Recreate and ONE RWO PVC mounted at `mount` — no HTTPScaledObject (a stateful app can't
  // scale to zero). Mutually exclusive with `schedule` and `processes` (a stateful worker map is out of
  // scope v1) — enforced in assertProcesses, not here. No snapshots/backups v1: steer real persistence
  // needs at I1 buckets or the managed DB (this is the escape hatch, not the path).
  stateful?: AppStateful;
}
export interface AppStateful {
  volume: string; // PVC size, a k8s binary-SI quantity (e.g. "2Gi"); clamped to [64Mi,10Gi] here — see
  // clampStatefulVolume. This is app-config's OWN static, pure ceiling (no DB/org lookup) — the REAL
  // per-org storage budget (Future.md item 10 `storage_budget_bytes`) is enforced server-side against
  // live usage, and may be lower; this bound just guarantees a malformed/huge request never reaches
  // the manifest layer.
  mount: string; // absolute container mount path (e.g. "/data"); validated — see validStatefulMount.
}

const DEFAULT_SERVICE: AppService = { internalPort: 8080, protocol: "http" };
const DEFAULT_RESOURCES: AppResources = { cpu: "0.5", memory: "512Mi" };
const DEFAULT_APP_SCALE: AppScale = { min: 0, max: 3 }; // web default (matches the manifest layer)
const RELEASE_DEFAULT_TIMEOUT_S = 300; // 5m
const RELEASE_MAX_TIMEOUT_S = 900; // 15m cap

// (I5) Constrained volumes. `STATEFUL_SCALE` is what `stateful` forces the web process to (see
// expandProcesses/assertProcesses); the storage bounds/default below are app-config's own static,
// pure ceiling — see the AppStateful.volume doc comment.
export const STATEFUL_SCALE: AppScale = { min: 1, max: 1 };
const STATEFUL_MIN_BYTES = 64 * 2 ** 20; // 64Mi floor — small enough to bound blast radius, big enough to be useful
const STATEFUL_MAX_BYTES = 10 * 2 ** 30; // 10Gi ceiling
const STATEFUL_MIN_LABEL = "64Mi";
const STATEFUL_MAX_LABEL = "10Gi";
const DEFAULT_STATEFUL_VOLUME = "2Gi";
const DEFAULT_STATEFUL_MOUNT = "/data";
const STATEFUL_STORAGE_RE = /^\d+(\.\d+)?(Mi|Gi|Ti)$/;
const STATEFUL_STORAGE_UNIT: Record<string, number> = { Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };

/** Parse a k8s binary-SI storage quantity (Mi/Gi/Ti only) to bytes, or null if malformed. Kept local
 *  (not imported from db-config.ts) so app-config stays a leaf module with no cross-config coupling —
 *  the two `storageToBytes`-shaped helpers are trivial and intentionally duplicated. */
function statefulStorageToBytes(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi|Ti)$/.exec(s);
  return m ? parseFloat(m[1]!) * STATEFUL_STORAGE_UNIT[m[2]!]! : null;
}

/** Clamp a requested volume size into [64Mi,10Gi]; junk/absent → the 2Gi default. Never throws — same
 *  defensive posture as `boundedSeconds` (durations), just for a k8s storage quantity. */
function clampStatefulVolume(v: unknown): string {
  const s = str(v, 32);
  if (!s || !STATEFUL_STORAGE_RE.test(s)) return DEFAULT_STATEFUL_VOLUME;
  const bytes = statefulStorageToBytes(s);
  if (bytes == null) return DEFAULT_STATEFUL_VOLUME;
  if (bytes < STATEFUL_MIN_BYTES) return STATEFUL_MIN_LABEL;
  if (bytes > STATEFUL_MAX_BYTES) return STATEFUL_MAX_LABEL;
  return s;
}

/** A stateful mount path: absolute, no ".." traversal, no trailing slash, never bare "/" (mounting over
 *  the whole container filesystem is never sane). Segment charset matches a sane filesystem path (wider
 *  than a DNS name, but no shell metacharacters/whitespace). */
function validStatefulMount(p: string): boolean {
  if (!p.startsWith("/") || p === "/" || p.endsWith("/")) return false;
  const segs = p.split("/").filter(Boolean);
  return segs.length > 0 && segs.every((s) => s !== ".." && s !== "." && /^[A-Za-z0-9._-]+$/.test(s));
}

/** Sanitize `app.stateful`: the object form `{volume?, mount?}` OR the boolean shorthand `stateful:
 *  true` (all defaults). `mount` absent → defaults to "/data" (always valid); an EXPLICIT but invalid
 *  mount (relative, "..", trailing slash, bare "/") drops the WHOLE block — a stateful declaration with
 *  no safe mount point is meaningless, unlike `volume` which always has a sane clamped fallback. */
function sanitizeStateful(raw: unknown): AppStateful | undefined {
  const v = raw === true ? {} : raw;
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const s = v as Record<string, unknown>;
  const mount = s.mount === undefined ? DEFAULT_STATEFUL_MOUNT : str(s.mount, 256);
  if (!mount || !validStatefulMount(mount)) return undefined;
  return { volume: clampStatefulVolume(s.volume), mount };
}

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

// (H2) Cron field bounds, in field order (minute, hour, day-of-month, month, day-of-week). Both 0
// and 7 mean Sunday in day-of-week — accepting both matches every mainstream cron implementation.
const CRON_FIELD_BOUNDS: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** One comma-separated cron field: `*`, `N`, `N-M`, optionally with a `/STEP` — any of those,
 *  comma-listed (e.g. "1,5-10,*\/15"). Defensive: a negative/out-of-range/inverted/non-numeric part
 *  fails the WHOLE field (the caller drops the whole `schedule` rather than accept a mangled one). */
function validCronField(field: string, min: number, max: number): boolean {
  if (!field) return false;
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(\/(\d+))?$/.exec(part);
    if (!m) return false;
    if (m[3] !== undefined && parseInt(m[3], 10) < 1) return false; // step 0 (or junk) is meaningless
    if (m[1] === "*") continue;
    const rm = /^(\d+)(?:-(\d+))?$/.exec(m[1]!)!;
    const lo = parseInt(rm[1]!, 10);
    const hi = rm[2] !== undefined ? parseInt(rm[2]!, 10) : lo;
    if (lo < min || hi > max || hi < lo) return false;
  }
  return true;
}

/** Sanitize a 5-field cron expression ("min hour dom month dow"); junk (wrong field count,
 *  out-of-range/negative numbers, garbage characters) drops the key entirely rather than accepting a
 *  mangled schedule. Whitespace is normalized to single spaces, so it re-sanitizes unchanged
 *  (round-trip safe: CLI -> JSON -> API). */
function sanitizeSchedule(v: unknown): string | undefined {
  const s = str(v, 128);
  if (!s) return undefined;
  const fields = s.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  for (let i = 0; i < 5; i++) {
    const [min, max] = CRON_FIELD_BOUNDS[i]!;
    if (!validCronField(fields[i]!, min, max)) return undefined;
  }
  return fields.join(" ");
}

// (H2) `command` at the app level (the CronJob's command): string → shell-form, array → exec-form —
// same convention as AppProcess.command (see the `processes` block below), just not tied to a process
// key. Kept as a small standalone helper (not shared with the `processes` loop) to avoid touching that
// block for an unrelated feature.
function sanitizeCommand(v: unknown): string | string[] | undefined {
  if (typeof v === "string" && v.length > 0 && v.length <= 4096) return v;
  if (Array.isArray(v)) {
    const arr = (v as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 4096);
    return arr.length ? arr : undefined;
  }
  return undefined;
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

  // `uses` declares dependencies on managed resources. Each entry is `{ database: <name> }` (CNPG
  // binding: envFrom `<db>-app` Secret + cluster CA + PGSSLMODE=verify-full; an optional `via: "pooler"`
  // (I3) routes PGHOST at the CNPG Pooler service) OR (I1) `{ bucket: <name> }` (object storage: S3_*
  // creds injected via the write-only secret path at deploy) OR (I2) `{ cache: <name> }` (REDIS_URL
  // injected via the write-only secret path) OR (H3) `{ app: <name> }` (service discovery: a PLAIN,
  // non-secret `<KEY>_URL` env pointing at that app's in-cluster Service, or its wake host when it
  // scales to zero — resolved at deploy). Same defensive posture as everything above: ignore non-array
  // input and junk entries, require a valid workload name, collapse duplicates per kind, and cap the
  // list. Round-trip safe — a sanitized entry re-sanitizes unchanged (CLI -> JSON -> API).
  if (Array.isArray(raw.uses)) {
    const uses: AppUse[] = [];
    const seen = new Set<string>();
    for (const u of (raw.uses as any[]).slice(0, 8)) {
      const database = str(u?.database, 63);
      const bucket = str(u?.bucket, 63);
      const cache = str(u?.cache, 63);
      const auth = str(u?.auth, 63);
      const appDep = str(u?.app, 63);
      if (database) {
        if (validateName(database) !== null || seen.has(`d:${database}`)) continue;
        seen.add(`d:${database}`);
        const entry: AppUse = { database };
        if (u?.via === "pooler") entry.via = "pooler"; // (I3) route PGHOST through the pooler (else the primary)
        uses.push(entry);
      } else if (bucket) {
        if (validateName(bucket) !== null || seen.has(`b:${bucket}`)) continue;
        seen.add(`b:${bucket}`);
        uses.push({ bucket });
      } else if (cache) {
        if (validateName(cache) !== null || seen.has(`c:${cache}`)) continue;
        seen.add(`c:${cache}`);
        uses.push({ cache });
      } else if (auth) {
        // (K1) an app→auth binding: deploy injects AUTH_URL + AUTH_JWT_SECRET (write-only) for the resource.
        if (validateName(auth) !== null || seen.has(`a:${auth}`)) continue;
        seen.add(`a:${auth}`);
        uses.push({ auth });
      } else if (appDep) {
        // (H3) an app→app binding (service discovery): deploy injects a plain `<KEY>_URL` env. The
        // target must be another app in the SAME org + namespace — enforced at deploy (server.ts), not here.
        if (validateName(appDep) !== null || seen.has(`p:${appDep}`)) continue;
        seen.add(`p:${appDep}`);
        uses.push({ app: appDep });
      }
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
    // (G2b) accept drop.yaml's `keep_warm` AND the sanitized `keepWarm` (round-trip safe: CLI→JSON→API).
    const keepWarm = (h.keep_warm ?? h.keepWarm) === true;
    const hasPath = !!path && path.startsWith("/");
    // A healthcheck block survives if it declares a real HTTP path (drives k8s probes) OR opts into
    // keep_warm (drives the uptime poller) — otherwise it's empty and dropped, same as before.
    if (hasPath || keepWarm) {
      cfg.healthcheck = {
        ...(hasPath
          ? { path, interval: boundedSeconds(h.interval, 1, 300, 10), timeout: boundedSeconds(h.timeout, 1, 60, 2), grace: boundedSeconds(h.grace, 0, 600, 15) }
          : {}),
        ...(keepWarm ? { keepWarm: true } : {}),
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
  // entries/values, cap the map, and re-sanitize unchanged. (L1b) `scale_on` activates KEDA queue
  // scaling on a worker (see the manifest layer); its `target` is clamped to [1,1000] here so a junk
  // or wildly out-of-range value never reaches the manifest layer. Web uniqueness (at most one web
  // process), scale_on-on-web rejection, and the scale_on/cache-binding requirement are all enforced
  // at deploy via assertProcesses, not dropped here.
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
      // accept drop.yaml's `scale_on` AND the sanitized `scaleOn` (round-trip safety). `target` is
      // CLAMPED into [1,1000] (not rejected) — same defensive posture as healthcheck durations — so a
      // typo'd 0 or a runaway 100000 becomes a sane bound instead of dropping the whole block.
      const so = (p.scale_on ?? p.scaleOn) as Record<string, unknown> | undefined;
      if (so && typeof so === "object") {
        const queue = str(so.queue, 253);
        const target = typeof so.target === "number" && isFinite(so.target) ? Math.min(1000, Math.max(1, Math.floor(so.target))) : undefined;
        if (queue && target != null) proc.scaleOn = { queue, target };
      }
      procs[key] = proc;
    }
    if (Object.keys(procs).length) cfg.processes = procs;
  }

  // `schedule` (H2) → a 5-field cron expression; junk drops the key (see sanitizeSchedule). Exclusivity
  // with `processes`/an explicit `services`/`healthcheck` is enforced at deploy via assertProcesses,
  // not here — sanitizing is purely syntactic.
  const schedule = sanitizeSchedule(raw.schedule);
  if (schedule) cfg.schedule = schedule;

  // `command` (H2) → the CronJob's command. Same string/array convention as a process's `command`.
  // Sanitized unconditionally (a harmless, ignored field on a non-`schedule` app).
  const command = sanitizeCommand(raw.command);
  if (command !== undefined) cfg.command = command;

  // `stateful` (I5) → a constrained volume. Junk (wrong type, or an explicit-but-invalid mount) drops
  // the whole block; exclusivity with `schedule`/`processes` and the forced scale are enforced at
  // deploy via assertProcesses/expandProcesses, not here — sanitizing is purely syntactic.
  const stateful = sanitizeStateful(raw.stateful);
  if (stateful) cfg.stateful = stateful;

  return cfg;
}

// (H2) The single default service (see DEFAULT_SERVICE above) isn't a real declaration — it's what
// `services` defaults to when the input has none. Compared by VALUE, not by how it arrived: an
// AppConfig round-tripped through JSON (CLI -> API) rebuilds `services` fresh each time, so there is
// no reliable way to remember "the input had no `services` key" past one sanitize call — comparing
// against the default's SHAPE is round-trip safe where a presence flag would not be. The practical
// consequence: a user who explicitly writes exactly `services: [{internal_port: 8080, protocol: http}]`
// alongside `schedule` is indistinguishable from one who wrote neither, and is allowed — a deliberate,
// documented tradeoff (see assertProcesses).
function isDefaultServices(services: AppService[]): boolean {
  return services.length === 1 && services[0]!.internalPort === DEFAULT_SERVICE.internalPort && services[0]!.protocol === DEFAULT_SERVICE.protocol;
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
 *
 * (H2) `schedule` turns the app into a CronJob, which has no web/worker processes, no listener, and
 * no probes — so it's rejected outright alongside `processes`, an explicitly-declared `services`
 * (the sanitizer's implicit default single service doesn't count — see isDefaultServices), and
 * `healthcheck`. These checks run BEFORE the web-uniqueness check below (schedule+processes should
 * name schedule as the conflict, not "two web processes").
 *
 * (L1b) Two more rules for `scale_on` (queue-scaled workers), both loud 400s rather than silent
 * drops: (a) it's meaningless on the web process — that process already scales on HTTP traffic via
 * the KEDA HTTP add-on, not a Valkey list — so a `scale_on` there is rejected outright; (b) it
 * requires at least one `{cache}` binding in `uses`, since the queue it watches lives in that bound
 * Valkey — without one the manifest layer would have no address to point the KEDA trigger at.
 *
 * (I5) `stateful` is boxed hard, three loud 400s: mutually exclusive with `schedule` (a CronJob has no
 * long-lived volume to keep across runs) and with `processes` (a stateful worker map is out of scope
 * v1 — a single implicit web process only); and an EXPLICIT `scale` that isn't exactly {min:1,max:1} is
 * rejected outright (the loud option — an absent `scale` is silently clamped to {1,1} instead, in
 * expandProcesses, since there's nothing explicit to contradict).
 */
export function assertProcesses(app: AppConfig): void {
  if (app.stateful) {
    if (app.schedule) throw new Error(`"stateful" and "schedule" are mutually exclusive — a CronJob has no long-lived volume to keep across runs`);
    if (app.processes) throw new Error(`"stateful" and "processes" are mutually exclusive — a stateful worker map is out of scope v1 (a single web process only)`);
    if (app.scale && (app.scale.min !== STATEFUL_SCALE.min || app.scale.max !== STATEFUL_SCALE.max)) {
      throw new Error(
        `"stateful" forces an always-on, single-replica Deployment (scale: {min:${STATEFUL_SCALE.min},max:${STATEFUL_SCALE.max}}) — got {min:${app.scale.min},max:${app.scale.max}}; drop "scale" to accept the default, or set it to {min:1,max:1} explicitly`,
      );
    }
  }
  if (app.schedule) {
    if (app.processes) throw new Error(`"schedule" and "processes" are mutually exclusive — a CronJob has no web/worker processes`);
    if (app.healthcheck) throw new Error(`"schedule" and "healthcheck" are mutually exclusive — probes are meaningless on a CronJob`);
    if (!isDefaultServices(app.services)) {
      throw new Error(`"schedule" and an explicitly-declared "services" are mutually exclusive — a CronJob has no listener`);
    }
  }
  if (!app.processes) return;
  const webs = Object.entries(app.processes).filter(([k, p]) => isWebProcess(k, p));
  if (webs.length > 1) {
    throw new Error(`an app may declare at most one "web" process; got ${webs.length} (${webs.map(([k]) => k).join(", ")})`);
  }
  const webScaleOn = webs.find(([, p]) => p.scaleOn);
  if (webScaleOn) {
    throw new Error(`"scale_on" is not valid on the web process ("${webScaleOn[0]}") — it already scales on HTTP traffic, not a queue`);
  }
  const hasScaleOn = Object.values(app.processes).some((p) => p.scaleOn);
  if (hasScaleOn && !(app.uses ?? []).some((u) => u.cache)) {
    throw new Error(`"scale_on" requires at least one {cache} binding in "uses" — the queue it watches lives in the bound Valkey cache`);
  }
}

/** A fully-resolved process (deployment name, web flag, scale, resources), ready for the manifest
 *  layer. Absent `processes:` yields exactly one implicit web process — today's single-process app. */
export interface ExpandedProcess {
  name: string; // Deployment name: `<app>` for web, `<app>-<key>` for a worker
  process: string; // the process key ("web" for the implicit process)
  web: boolean; // gets Service + HTTPScaledObject; workers get a plain Deployment
  command?: string | string[];
  scale: AppScale; // web: KEDA bounds; worker: static replicas (min≥1) — UNLESS scaleOn (see below)
  resources?: AppResources;
  scaleOn?: { queue: string; target: number }; // (L1b) present → the manifest layer emits a KEDA ScaledObject for this worker
}

/** Expand an AppConfig into its concrete processes. Workers get min≥1 static scale (a scale-to-zero
 *  worker has no wake source, so it would never run) — UNLESS the worker declares `scale_on` (L1b): a
 *  queue-scaled worker IS woken by something (KEDA watching the bound Valkey list depth), so min:0 is
 *  safe and is the default (idle queue → zero pods); max also defaults higher (3, matching web) since
 *  such a worker is expected to actually scale. Per-process resources/scale override the app-level
 *  defaults; command is per-process only. */
export function expandProcesses(app: AppConfig, appName: string): ExpandedProcess[] {
  // (I5) A stateful app's web process defaults to an always-on single replica ({min:1,max:1}) instead
  // of the normal 0..3 KEDA range, whenever no explicit `scale` is declared anywhere (app- or
  // process-level) — the "clamp when absent" half of the forced-scale rule (assertProcesses 400s an
  // EXPLICIT mismatch instead). assertProcesses rejects `processes` alongside `stateful` outright, so
  // only the implicit-web branch below is reachable for a stateful app in practice — the fallback is
  // still computed for both so this function stays correct standalone (never assumes the caller validated).
  const defaultScale = app.stateful ? STATEFUL_SCALE : DEFAULT_APP_SCALE;
  if (!app.processes) {
    return [{ name: appName, process: "web", web: true, scale: app.scale ?? { ...defaultScale }, resources: app.resources }];
  }
  const out: ExpandedProcess[] = [];
  for (const [key, p] of Object.entries(app.processes)) {
    if (isWebProcess(key, p)) {
      out.push({
        name: appName,
        process: key,
        web: true,
        command: p.command,
        scale: p.scale ?? app.scale ?? { ...defaultScale },
        resources: p.resources ?? app.resources,
        scaleOn: p.scaleOn,
      });
    } else {
      // Workers are static (no HTTPScaledObject) with min≥1 — UNLESS this worker declares `scale_on`
      // (L1b): a KEDA ScaledObject then owns its replica count between min and max, and min:0 is safe
      // (queue depth is the wake source, unlike a plain worker with none), so it's the default rather
      // than being clamped up to 1. max defaults to 3 (not 1) for the same reason — a queue-scaled
      // worker is meant to scale, not sit at a single static replica.
      const min = p.scaleOn ? Math.max(0, p.scale?.min ?? 0) : Math.max(1, p.scale?.min ?? 1);
      const max = p.scaleOn ? Math.max(min, p.scale?.max ?? 3) : Math.max(min, p.scale?.max ?? 1);
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
