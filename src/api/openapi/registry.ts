// L5 — the platform-API route schema registry.
//
// This is a PARALLEL spec registry: it never wraps the Hono app (see src/api/server.ts, which stays a
// plain hand-routed Hono). Instead each stable, publicly-documented route registers a `RouteDef` here
// describing its method/path/summary + a zod schema for its response (and, where it has one, its JSON
// request body). The zod schemas are the DOCUMENTATION OF TRUTH — the conformance test
// (conformance.test.ts) hits each registered route on the in-proc app and validates the live response
// against its schema, so the generated OpenAPI spec can never silently drift from the API.
//
// Migration is opportunistic: only a representative subset of routes is registered today; more get added
// as they stabilise. Nothing here is a big-bang rewrite of the 100+ existing routes.

import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One documented query-string parameter. Path params are DERIVED from the path (`:name` segments). */
export interface QueryParam {
  name: string;
  required?: boolean;
  description?: string;
}

/** A route's request body. Either a JSON body (a zod `schema`) or an opaque `binary` upload. */
export interface RequestBodyDef {
  contentType: string;
  /** zod schema for a JSON body (omit for a binary upload). */
  schema?: z.ZodType;
  /** true → an opaque binary stream (e.g. a gzip tarball); no schema. */
  binary?: boolean;
  description?: string;
}

export interface RouteDef {
  method: HttpMethod;
  /** The Hono-style path, e.g. `/v1/sites/:name`. `:seg` segments become OpenAPI `{seg}` path params. */
  path: string;
  /** Stable identifier → the generated client's method name (e.g. `listSites`). Must be unique. */
  operationId: string;
  summary: string;
  tags: string[];
  /** Documented query params (optional). */
  query?: QueryParam[];
  /** Request body (optional). */
  requestBody?: RequestBodyDef;
  /** zod schema for the 200 response body. */
  response: z.ZodType;
  responseDescription?: string;
}

/** A tiny ordered collection of route definitions. Registration order is preserved (deterministic spec). */
export class Registry {
  private readonly routes: RouteDef[] = [];
  private readonly seen = new Set<string>();

  register(def: RouteDef): this {
    if (this.seen.has(def.operationId)) throw new Error(`duplicate operationId: ${def.operationId}`);
    this.seen.add(def.operationId);
    this.routes.push(def);
    return this;
  }

  all(): readonly RouteDef[] {
    return this.routes;
  }

  byOperationId(id: string): RouteDef | undefined {
    return this.routes.find((r) => r.operationId === id);
  }
}

/** Turn a Hono path (`/v1/orgs/:slug/usage`) into an OpenAPI path (`/v1/orgs/{slug}/usage`). */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** The `:seg` path-param names, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}
