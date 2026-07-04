// Per-cache config, declared under `cache:` in drop.yaml (sibling to `site:`/`app:`/`database:`).
// Parsed at create time; the API translates it into a single-replica Valkey Deployment + Service
// (+ an optional small PVC when `persistent`) in the tenant namespace (see src/kube/valkey.ts).
// Deliberately tiny — the anti-Redis-Cluster: no HA, no clustering, EPHEMERAL by default (a restart
// loses the data unless `persistent: true`). Mirrors db-config.ts conventions (defensive, junk-
// ignoring, round-trip safe: re-sanitizing a CacheConfig yields the same CacheConfig).
import { parse as parseYaml } from "yaml";

export interface CacheConfig {
  name?: string;
  memory: string; // Valkey `maxmemory` + the pod's memory limit, a k8s quantity (e.g. "256Mi")
  persistent: boolean; // true → a small PVC at /data with `--save 60 1`; false (default) → EPHEMERAL
}

// Memory is clamped into [64Mi, 1Gi]; the default sits comfortably in the middle. Kept small on
// purpose — a big cache wants a real Redis, which is out of scope for this primitive.
const DEFAULT_MEMORY = "256Mi";
export const MIN_CACHE_MEMORY_BYTES = 64 * 2 ** 20; // 64Mi
export const MAX_CACHE_MEMORY_BYTES = 1 * 2 ** 30; // 1Gi
const MEMORY_RE = /^\d+(\.\d+)?(Mi|Gi)$/; // a sane memory quantity (binary SI; Mi/Gi only for a cache)
const MEMORY_UNIT: Record<string, number> = { Mi: 2 ** 20, Gi: 2 ** 30 };

/** Parse a k8s binary-SI memory quantity (e.g. "256Mi", "1Gi") to bytes, or null if malformed. */
export function cacheMemoryToBytes(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi)$/.exec(s);
  return m ? parseFloat(m[1]!) * MEMORY_UNIT[m[2]!]! : null;
}

/** Validate an explicitly-requested cache memory value. Returns an error string, or null when
 *  acceptable (including when none is requested → the default applies). Unlike the DB storage cap
 *  (which rejects over-cap), memory is CLAMPED into [64Mi,1Gi] by the sanitizer — so this only
 *  rejects a clearly-malformed quantity, letting the CLI/control-plane fail loudly on typos. */
export function validateCacheMemory(input: unknown): string | null {
  if (input == null || typeof input !== "object") return null;
  const m = (input as Record<string, unknown>).memory;
  if (m == null) return null; // not requested → server default
  if (typeof m !== "string" || !MEMORY_RE.test(m)) return `invalid memory ${JSON.stringify(m)} — use a k8s quantity like 128Mi or 1Gi`;
  return null;
}

function str(v: unknown, max = 2048): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** Clamp a well-formed memory quantity into [64Mi,1Gi], returning a canonical Mi/Gi string.
 *  Junk → the default. Round-trip safe: a clamped value re-clamps to itself. */
function clampMemory(v: unknown): string {
  const s = str(v, 32);
  if (!s || !MEMORY_RE.test(s)) return DEFAULT_MEMORY;
  const bytes = cacheMemoryToBytes(s);
  if (bytes == null) return DEFAULT_MEMORY;
  if (bytes < MIN_CACHE_MEMORY_BYTES) return "64Mi";
  if (bytes > MAX_CACHE_MEMORY_BYTES) return "1Gi";
  return s;
}

/**
 * Sanitize a parsed `cache:` object → CacheConfig. Returns undefined only for a clearly invalid
 * scalar input; an empty/null object yields a default cache (a cache has no required field —
 * sensible defaults stand in). The "is there a cache section?" decision lives in parseCacheConfig
 * (key presence).
 */
export function sanitizeCacheConfig(input: unknown): CacheConfig | undefined {
  if (input != null && typeof input !== "object") return undefined;
  const raw = (input ?? {}) as Record<string, unknown>;

  // `name` is validated by the caller's target-name check (like db-config): accept a well-formed
  // label, ignore junk. (validateName is applied at the API boundary against the route name.)
  const cfg: CacheConfig = { memory: clampMemory(raw.memory), persistent: raw.persistent === true };
  const name = str(raw.name, 63);
  if (name) cfg.name = name;
  return cfg;
}

/** The PVC size for a persistent cache: sized to its memory (the working set + a little RDB slack is
 *  bounded by maxmemory anyway). Ephemeral caches have no PVC → contribute 0 to the storage budget. */
export function cachePvcSize(cfg: CacheConfig): string {
  return cfg.memory;
}

/** Parse a `drop.yaml` body and return its `cache:` section, or undefined if absent. Throws a clear
 *  error if the section requests a malformed memory quantity, so the CLI (and MCP) reject it up front
 *  rather than silently coercing it to the default. */
export function parseCacheConfig(text: string): CacheConfig | undefined {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || !("cache" in doc)) return undefined;
  const raw = (doc as Record<string, unknown>).cache;
  const err = validateCacheMemory(raw);
  if (err) throw new Error(err);
  return sanitizeCacheConfig(raw);
}
