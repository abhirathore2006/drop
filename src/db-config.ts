// Per-database config, declared under `database:` in drop.yaml (sibling to `site:`/`app:`).
// Parsed at create time; the API translates it into a CloudNativePG `Cluster` (+ backups
// via the Barman Cloud Plugin) in the tenant namespace. v1 supports a single Postgres
// engine; storage + scheduled hibernation are the tunable knobs.
import { randomBytes } from "node:crypto";
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

// A user-supplied DB password: printable, no whitespace/quote/backslash (keeps it safe in a
// connection string and out of trouble even if some tool interpolates it), 12–128 chars.
const DB_PASSWORD_RE = /^[A-Za-z0-9!#$%&()*+,\-./:;<=>?@[\]^_{|}~]{12,128}$/;

/** Validate a caller-provided DB password; returns an error string, or null if acceptable. */
export function validateDbPassword(pw: unknown): string | null {
  if (typeof pw !== "string") return "password must be a string";
  if (!DB_PASSWORD_RE.test(pw)) return "password must be 12–128 chars, printable, no spaces or quotes/backslash";
  // Reject trivially weak values (e.g. "aaaaaaaaaaaa", "012012012012") — a low bar, but it
  // stops the obviously-guessable. The generated path far exceeds this.
  if (new Set(pw).size < 5) return "password is too weak (too few distinct characters)";
  return null;
}

/** Generate a strong random DB password (URL-safe base64, ~25 chars / 144 bits). Always
 *  matches DB_PASSWORD_RE (base64url alphabet is a subset of the allowed set). */
export function generateDbPassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Parse a `drop.yaml` body and return its `database:` section, or undefined if absent. */
export function parseDatabaseConfig(text: string): DatabaseConfig | undefined {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || !("database" in doc)) return undefined;
  return sanitizeDatabaseConfig((doc as Record<string, unknown>).database);
}
