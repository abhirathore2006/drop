// @drop/config — the app-side SDK for Drop runtime config (L4).
//
// Runtime config is a per-app, NON-SECRET key/value store on the Drop control plane — a lighter path than
// a redeploy for flipping a flag or tweaking a knob. This client polls `GET <config-url>` on an interval
// (30s default) with an `If-None-Match` ETag, caches the map in memory, and fires `onChange` only when the
// server's version advances. It is dependency-free and uses the runtime's global `fetch` (injectable for
// tests and non-standard runtimes).
//
// WHAT DOESN'T BELONG HERE: secrets. Config values are stored + returned in PLAINTEXT (that's why the
// control plane refuses credential-looking values). Use Drop's write-only secret path for credentials.
//
// ZERO-CONFIG IN A DROP APP: on your first `drop config set <app> …`, Drop injects `DROP_CONFIG_URL` (the
// endpoint to poll) and `DROP_CONFIG_TOKEN` (a read-only, config-scoped token) into the app's environment
// on its next restart/deploy — so `createConfigClient()` needs no arguments there. Pass `{ url, token }`
// explicitly anywhere else (tests, scripts, custom runtimes).

/** A machine-readable failure (no URL, no fetch, a non-2xx poll, a bad body). */
export class ConfigError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

/** A minimal fetch shape so the SDK needs no DOM lib and accepts an injected fetch (tests, custom agents).
 *  Mirrors @drop/auth's FetchLike. A 304 is delivered as `{ ok:false, status:304 }` — handled explicitly. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Called with a fresh copy of the map + its version each time the config CHANGES (never on a 304). */
export type ChangeListener = (config: Record<string, string>, version: number) => void;

export interface ConfigClientOptions {
  /** The config endpoint to poll. Defaults to `DROP_CONFIG_URL` (Drop injects it). */
  url?: string;
  /** Bearer token for the read. Defaults to `DROP_CONFIG_TOKEN` (Drop injects it). Omit for an open endpoint. */
  token?: string;
  /** Poll interval in ms (default 30000). `<= 0` disables the background poll — call `refresh()` yourself. */
  pollMs?: number;
  /** Injected fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Optional sink for poll errors; a failed poll keeps the last-known map and never throws. */
  onError?: (err: Error) => void;
}

export interface ConfigClient {
  /** The current value for `key`, or undefined. Reads the in-memory cache (no network). */
  get(key: string): string | undefined;
  /** A COPY of the whole config map (mutating it never affects the client). */
  getAll(): Record<string, string>;
  /** Subscribe to changes; fires with `(config, version)` on every version advance. Returns an unsubscribe. */
  onChange(cb: ChangeListener): () => void;
  /** Poll once, now. Resolves after the cache is updated (or the error is routed to `onError`). */
  refresh(): Promise<void>;
  /** Stop the background poll (idempotent). */
  stop(): void;
  /** The current version ETag (0 until the first successful load). */
  readonly version: number;
}

/** Read an env var without assuming a Node `process` exists (browser-safe; mirrors @drop/auth). */
function env(name: string): string | undefined {
  return typeof process !== "undefined" && process?.env ? process.env[name] : undefined;
}

/**
 * Create a runtime-config client bound to an app's config endpoint. `url`/`token` default to
 * `DROP_CONFIG_URL`/`DROP_CONFIG_TOKEN`. Unless `pollMs <= 0`, it immediately kicks off a load and then
 * polls every `pollMs`; the poll timer is `unref`'d so it never keeps a process alive on its own.
 */
export function createConfigClient(opts: ConfigClientOptions = {}): ConfigClient {
  const url = (opts.url ?? env("DROP_CONFIG_URL") ?? "").replace(/\/+$/, "");
  if (!url) throw new ConfigError("no config URL — pass { url } or set DROP_CONFIG_URL (Drop injects it after your first `drop config set`)", "no_url");
  const token = opts.token ?? env("DROP_CONFIG_TOKEN");
  const doFetch = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike | undefined);
  if (!doFetch) throw new ConfigError("no fetch available in this runtime — pass { fetch }", "no_fetch");
  const pollMs = opts.pollMs ?? 30_000;

  let map: Record<string, string> = {};
  let version: number | null = null; // null = never loaded; the first load always fires onChange
  const listeners = new Set<ChangeListener>();

  const getAll = (): Record<string, string> => ({ ...map });

  async function refresh(): Promise<void> {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (version != null) headers["if-none-match"] = `W/"${version}"`; // ETag round-trip → a cheap 304
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch!(url, { method: "GET", headers });
    } catch (e) {
      opts.onError?.(e instanceof Error ? e : new ConfigError(String(e), "network"));
      return;
    }
    if (res.status === 304) return; // unchanged — keep the cached map, fire nothing
    if (!res.ok) {
      opts.onError?.(new ConfigError(`config poll failed (${res.status})`, "http"));
      return;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      opts.onError?.(new ConfigError("config response was not JSON", "bad_body"));
      return;
    }
    const b = (body ?? {}) as { config?: unknown; version?: unknown };
    const nextVersion = typeof b.version === "number" ? b.version : version ?? 0;
    if (nextVersion === version) return; // 200 but no version advance → treat as unchanged
    map = b.config && typeof b.config === "object" ? { ...(b.config as Record<string, string>) } : {};
    version = nextVersion;
    const snapshot = getAll();
    for (const cb of listeners) {
      try {
        cb(snapshot, nextVersion);
      } catch {
        /* a listener that throws must never break the poll loop or other listeners */
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (pollMs > 0) {
    void refresh(); // initial load
    timer = setInterval(() => void refresh(), pollMs);
    // Don't let the poll timer alone keep a Node process alive (best-effort; not all runtimes have unref).
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  return {
    get: (key) => map[key],
    getAll,
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    refresh,
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    get version() {
      return version ?? 0;
    },
  };
}
