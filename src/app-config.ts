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
export interface AppConfig {
  name?: string;
  image: string;
  resources?: AppResources;
  env?: Record<string, string>;
  services: AppService[];
  scale?: AppScale;
  trusted?: boolean; // default true (no sandbox); false opts into the gVisor RuntimeClass (prod)
}

const DEFAULT_SERVICE: AppService = { internalPort: 8080, protocol: "http" };
const DEFAULT_RESOURCES: AppResources = { cpu: "0.5", memory: "512Mi" };

function str(v: unknown, max = 2048): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** Sanitize a parsed `app:` object → AppConfig, or undefined when there's no valid image. */
export function sanitizeAppConfig(input: unknown): AppConfig | undefined {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const image = str(raw.image, 512);
  if (!image) return undefined;

  const cfg: AppConfig = { image, services: [] };

  const name = str(raw.name, 63);
  if (name && validateName(name) === null) cfg.name = name;

  if (raw.resources && typeof raw.resources === "object") {
    const r = raw.resources as Record<string, unknown>;
    const cpu = str(r.cpu, 32);
    const memory = str(r.memory, 32);
    if (cpu || memory) cfg.resources = { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) };
  }
  if (!cfg.resources) cfg.resources = { ...DEFAULT_RESOURCES }; // never unbounded (LIM-1)
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

  if (raw.scale && typeof raw.scale === "object") {
    const s = raw.scale as Record<string, unknown>;
    const min = typeof s.min === "number" && s.min >= 0 ? s.min : undefined;
    const max = typeof s.max === "number" && s.max >= 1 ? s.max : undefined;
    if (min != null && max != null && max >= min) cfg.scale = { min, max };
  }

  return cfg;
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
