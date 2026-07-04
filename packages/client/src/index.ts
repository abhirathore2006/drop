// @drop/client — a typed fetch client for the Drop platform API (L5).
//
// The typed methods + response types are GENERATED from the OpenAPI spec (./generated.ts, produced by
// scripts/gen-client.mjs from docs/openapi.json). This file is the small, stable RUNTIME wrapper:
// createClient builds the low-level `request` (base URL, query-string, headers, JSON parse, error
// mapping) and hands it to the generated method factory. ZERO runtime dependencies — it uses the
// runtime's global `fetch` (injectable for tests / non-standard runtimes).
//
// The Drop CLI (src/cli/client.ts) is the first consumer, which makes it the permanent conformance test:
// if a generated method's shape drifts from the live API, the CLI's own e2e/command tests catch it.

import { createMethods, type DropMethods, type RequestOptions, type RequestBody } from "./generated.ts";

export * from "./generated.ts";

/** A machine-readable non-2xx failure. `body` is the parsed JSON (Drop errors carry `{ error }`). */
export class DropApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DropApiError";
    this.status = status;
    this.body = body;
  }
}

/** A minimal fetch shape so the client needs no DOM lib and accepts an injected fetch (mirrors @drop/config). */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: RequestBody; duplex?: "half" },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ClientOptions {
  /** Absolute base URL of the Drop API, e.g. `https://drop.example.com`. */
  baseUrl: string;
  /** Injected fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Extra headers per request — a static map or a (possibly async) factory (e.g. a bearer token). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
}

/** Create a typed Drop API client. Returns one method per registered route (see ./generated.ts). */
export function createClient(opts: ClientOptions): DropMethods {
  const doFetch = (opts.fetch ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
  const base = opts.baseUrl.replace(/\/+$/, "");

  const request = async (method: string, path: string, o: RequestOptions = {}): Promise<unknown> => {
    let url = base + path;
    if (o.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(o.query)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> =
      typeof opts.headers === "function" ? { ...(await opts.headers()) } : { ...(opts.headers ?? {}) };
    if (o.contentType) headers["content-type"] = o.contentType;

    const init: { method: string; headers: Record<string, string>; body?: RequestBody; duplex?: "half" } = { method, headers };
    if (o.body !== undefined) {
      init.body = o.body;
      init.duplex = "half"; // required by fetch when streaming a request body; harmless otherwise
    }
    const res = await doFetch(url, init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (json as { error?: string })?.error ?? `${path}: ${res.status}`;
      throw new DropApiError(message, res.status, json);
    }
    return json;
  };

  return createMethods(request);
}
