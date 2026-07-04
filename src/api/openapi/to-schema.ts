// L5 — a hand-rolled zod → JSON Schema (OpenAPI 3.1) converter + spec assembler.
//
// NO new dependency: this walks zod v4's internal schema definitions (`schema._zod.def`) directly and
// emits JSON Schema 2020-12 (which OpenAPI 3.1 uses verbatim). It covers exactly the zod features the
// registered routes use — object / string / number(+integer) / boolean / array / optional / nullable /
// enum / record / literal / union / any|unknown. Anything else falls through to `{}` (accept-anything)
// rather than throwing, so a future schema never breaks the build silently — it just under-documents.

import type { z } from "zod";
import { type RouteDef, type Registry, openApiPath, pathParamNames } from "./registry.ts";

export type JsonSchema = Record<string, unknown>;

/** zod v4 stashes the schema definition on `._zod.def`; this is the single place we reach into it. */
function defOf(schema: unknown): any {
  return (schema as any)?._zod?.def;
}

function primitiveType(v: unknown): "string" | "number" | "boolean" {
  return typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
}

/** Is a `number` schema constrained to a safe integer (`z.number().int()`)? */
function isInteger(d: any): boolean {
  const checks: any[] = Array.isArray(d?.checks) ? d.checks : [];
  return checks.some((c) => {
    const cd = c?._zod?.def ?? c;
    return cd?.format === "safeint" || cd?.format === "int32" || cd?.format === "int64";
  });
}

/** Convert a zod schema to a JSON Schema object. Pure; no side effects. */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const d = defOf(schema);
  if (!d) return {};
  switch (d.type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: isInteger(d) ? "integer" : "number" };
    case "boolean":
      return { type: "boolean" };
    case "any":
    case "unknown":
      return {};
    case "literal": {
      const values: unknown[] = d.values ?? [];
      if (values.length === 1) return { type: primitiveType(values[0]), const: values[0] };
      return { enum: values };
    }
    case "enum": {
      const values = Object.values(d.entries ?? {});
      return { type: "string", enum: values };
    }
    case "array":
      return { type: "array", items: zodToJsonSchema(d.element) };
    case "object": {
      const shape: Record<string, z.ZodType> = d.shape ?? {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        const fd = defOf(field);
        const optional = fd?.type === "optional" || fd?.type === "default";
        properties[key] = zodToJsonSchema(field);
        if (!optional) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length) out.required = required;
      // NOTE: additionalProperties is intentionally omitted (JSON Schema default = open). The API's
      // best-effort per-type detail blocks mean responses can carry MORE than a schema documents; an
      // open object keeps the spec truthful (mirrors zod's default strip-extras parse behaviour).
      return out;
    }
    case "optional":
    case "default":
      return zodToJsonSchema(d.innerType);
    case "nullable": {
      const inner = zodToJsonSchema(d.innerType);
      // Only collapse to `type: [prim, "null"]` for a BARE primitive; objects/arrays/records/enums keep
      // their structure via anyOf so downstream (TS codegen, validators) don't lose it.
      const keys = Object.keys(inner);
      const bare = keys.length === 1 && typeof inner.type === "string" && ["string", "number", "integer", "boolean"].includes(inner.type as string);
      return bare ? { ...inner, type: [inner.type as string, "null"] } : { anyOf: [inner, { type: "null" }] };
    }
    case "record":
      return { type: "object", additionalProperties: zodToJsonSchema(d.valueType) };
    case "union":
      return { anyOf: (d.options ?? []).map((o: z.ZodType) => zodToJsonSchema(o)) };
    default:
      return {};
  }
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, unknown>>;
}

/** Assemble an OpenAPI 3.1 document from the registry. `version` tags `info.version` (see gen scripts). */
export function buildOpenApiDocument(registry: Registry, version: string): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();

  for (const route of registry.all()) {
    for (const t of route.tags) tagSet.add(t);
    const p = openApiPath(route.path);
    const item = (paths[p] ??= {});
    item[route.method.toLowerCase()] = operationOf(route);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Drop Platform API",
      version,
      description:
        "The Drop control-plane HTTP API. A representative, conformance-verified subset of the routes " +
        "is documented here (see docs/api-reference.html). Generated from src/api/openapi — do not edit " +
        "docs/openapi.json by hand.",
    },
    tags: [...tagSet].sort().map((name) => ({ name })),
    paths,
  };
}

function operationOf(route: RouteDef): Record<string, unknown> {
  const op: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
  };

  const parameters: Record<string, unknown>[] = [];
  for (const name of pathParamNames(route.path)) {
    parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
  }
  for (const q of route.query ?? []) {
    parameters.push({
      name: q.name,
      in: "query",
      required: q.required ?? false,
      ...(q.description ? { description: q.description } : {}),
      schema: { type: "string" },
    });
  }
  if (parameters.length) op.parameters = parameters;

  if (route.requestBody) {
    const schema = route.requestBody.binary
      ? { type: "string", format: "binary" }
      : route.requestBody.schema
        ? zodToJsonSchema(route.requestBody.schema)
        : {};
    op.requestBody = {
      required: true,
      ...(route.requestBody.description ? { description: route.requestBody.description } : {}),
      content: { [route.requestBody.contentType]: { schema } },
    };
  }

  op.responses = {
    "200": {
      description: route.responseDescription ?? "OK",
      content: { "application/json": { schema: zodToJsonSchema(route.response) } },
    },
  };

  return op;
}
