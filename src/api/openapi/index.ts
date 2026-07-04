// L5 — public entry for the OpenAPI module. Imported by src/api/server.ts (to serve the spec) and by the
// gen/check scripts (bundled with esbuild). `buildSpec(version)` is the single assembly point so the
// served spec, the committed docs/openapi.json, and the CI gate all produce the identical document.

import { apiRegistry } from "./routes.ts";
import { buildOpenApiDocument, type OpenApiDocument } from "./to-schema.ts";

export { apiRegistry } from "./routes.ts";
export { zodToJsonSchema, buildOpenApiDocument, type OpenApiDocument, type JsonSchema } from "./to-schema.ts";
export { Registry, type RouteDef, openApiPath, pathParamNames } from "./registry.ts";

/** The API's contract version = the semver (git-sha build suffix stripped) so the committed spec is
 *  deterministic across commits and the diff gate keys on a real, human-bumped version. */
export function apiVersion(fullVersion: string): string {
  return fullVersion.split("+")[0]!;
}

/** Assemble the OpenAPI 3.1 document tagged with `version`. */
export function buildSpec(version: string): OpenApiDocument {
  return buildOpenApiDocument(apiRegistry, version);
}
