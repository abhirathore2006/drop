// Per-database config, declared under `database:` in drop.yaml (sibling to `site:`/`app:`).
// Parsed at create time; the API translates it into a CloudNativePG `Cluster` (+ backups
// via the Barman Cloud Plugin) in the tenant namespace. v1 supports a single Postgres
// engine; storage + scheduled hibernation are the tunable knobs.
import { parse as parseYaml } from "yaml";
import { validateName } from "./names.ts";

export type DatabaseEngine = "postgres-18";
export type Hibernation = "none" | "scheduled";

export interface DatabaseConfig {
  name?: string;
  engine: DatabaseEngine; // v1 pins to the repo-standard Postgres major
  storage: string; // PVC size, a k8s quantity (e.g. "10Gi")
  hibernation: Hibernation; // "scheduled" opts into the idle-shutdown CronJob (cost intent)
}

const ENGINE: DatabaseEngine = "postgres-18";
const DEFAULT_STORAGE = "10Gi";
const STORAGE_RE = /^\d+(\.\d+)?(Mi|Gi|Ti)$/; // a sane PVC quantity (binary SI)

function str(v: unknown, max = 2048): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/**
 * Sanitize a parsed `database:` object → DatabaseConfig. Returns undefined only for a
 * clearly invalid scalar input; an empty/null object yields a default Postgres (a DB has
 * no required field — sensible defaults stand in). The "is there a database section?"
 * decision lives in parseDatabaseConfig (key presence).
 */
export function sanitizeDatabaseConfig(input: unknown): DatabaseConfig | undefined {
  if (input != null && typeof input !== "object") return undefined;
  const raw = (input ?? {}) as Record<string, unknown>;

  const cfg: DatabaseConfig = { engine: ENGINE, storage: DEFAULT_STORAGE, hibernation: "none" };

  const name = str(raw.name, 63);
  if (name && validateName(name) === null) cfg.name = name;

  const storage = str(raw.storage, 32);
  if (storage && STORAGE_RE.test(storage)) cfg.storage = storage;

  if (raw.hibernation === "scheduled") cfg.hibernation = "scheduled";

  // engine: v1 pins to postgres-18 regardless of what's requested (future engines are
  // additive). We don't error on an unknown engine — we pin to the supported one.
  return cfg;
}

/** Parse a `drop.yaml` body and return its `database:` section, or undefined if absent. */
export function parseDatabaseConfig(text: string): DatabaseConfig | undefined {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || !("database" in doc)) return undefined;
  return sanitizeDatabaseConfig((doc as Record<string, unknown>).database);
}
