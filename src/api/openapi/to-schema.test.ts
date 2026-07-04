import { test, expect } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema, buildOpenApiDocument } from "./to-schema.ts";
import { Registry } from "./registry.ts";

// ---- the hand-rolled zod v4 → JSON Schema converter, one case per supported feature ----
test("string", () => expect(zodToJsonSchema(z.string())).toEqual({ type: "string" }));
test("number", () => expect(zodToJsonSchema(z.number())).toEqual({ type: "number" }));
test("integer (z.number().int())", () => expect(zodToJsonSchema(z.number().int())).toEqual({ type: "integer" }));
test("boolean", () => expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" }));
test("array", () => expect(zodToJsonSchema(z.array(z.string()))).toEqual({ type: "array", items: { type: "string" } }));

test("enum → string + enum values", () =>
  expect(zodToJsonSchema(z.enum(["a", "b", "c"]))).toEqual({ type: "string", enum: ["a", "b", "c"] }));

test("literal → const + primitive type", () => {
  expect(zodToJsonSchema(z.literal("x"))).toEqual({ type: "string", const: "x" });
  expect(zodToJsonSchema(z.literal(7))).toEqual({ type: "number", const: 7 });
  expect(zodToJsonSchema(z.literal(true))).toEqual({ type: "boolean", const: true });
});

test("record → object with additionalProperties", () =>
  expect(zodToJsonSchema(z.record(z.string(), z.number()))).toEqual({ type: "object", additionalProperties: { type: "number" } }));

test("union → anyOf", () =>
  expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] }));

test("any / unknown → open schema", () => {
  expect(zodToJsonSchema(z.any())).toEqual({});
  expect(zodToJsonSchema(z.unknown())).toEqual({});
});

test("nullable primitive → type tuple with null", () =>
  expect(zodToJsonSchema(z.string().nullable())).toEqual({ type: ["string", "null"] }));

test("nullable object → anyOf keeps structure", () =>
  expect(zodToJsonSchema(z.object({ a: z.string() }).nullable())).toEqual({
    anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "null" }],
  }));

test("object: required excludes optional + default; nested types resolved", () => {
  const schema = z.object({
    id: z.string(),
    count: z.number().int(),
    label: z.string().optional(),
    role: z.enum(["x", "y"]).default("x"),
    tags: z.array(z.string()),
  });
  expect(zodToJsonSchema(schema)).toEqual({
    type: "object",
    properties: {
      id: { type: "string" },
      count: { type: "integer" },
      label: { type: "string" },
      role: { type: "string", enum: ["x", "y"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["id", "count", "tags"],
  });
});

test("objects are open (no additionalProperties emitted) — mirrors the API's best-effort extra fields", () => {
  const out = zodToJsonSchema(z.object({ a: z.string() })) as Record<string, unknown>;
  expect("additionalProperties" in out).toBe(false);
});

// ---- OpenAPI 3.1 document assembly from a registry ----
test("buildOpenApiDocument: version, tags, path templating, params, requestBody + response schema", () => {
  const reg = new Registry();
  reg.register({
    method: "GET",
    path: "/v1/things/:id",
    operationId: "getThing",
    summary: "Get a thing.",
    tags: ["things"],
    query: [{ name: "expand", required: false }],
    response: z.object({ id: z.string(), n: z.number() }),
  });
  reg.register({
    method: "POST",
    path: "/v1/things/:id/upload",
    operationId: "uploadThing",
    summary: "Upload bytes.",
    tags: ["things"],
    requestBody: { contentType: "application/gzip", binary: true },
    response: z.object({ ok: z.boolean() }),
  });

  const doc = buildOpenApiDocument(reg, "9.9.9");
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.info.version).toBe("9.9.9");
  expect(doc.tags).toEqual([{ name: "things" }]);

  // path is templated (:id → {id})
  const get = doc.paths["/v1/things/{id}"].get as any;
  expect(get.operationId).toBe("getThing");
  expect(get.responses["200"].content["application/json"].schema).toEqual({
    type: "object",
    properties: { id: { type: "string" }, n: { type: "number" } },
    required: ["id", "n"],
  });
  // a path param + the declared query param
  expect(get.parameters).toEqual([
    { name: "id", in: "path", required: true, schema: { type: "string" } },
    { name: "expand", in: "query", required: false, schema: { type: "string" } },
  ]);

  // binary requestBody
  const post = doc.paths["/v1/things/{id}/upload"].post as any;
  expect(post.requestBody.content["application/gzip"].schema).toEqual({ type: "string", format: "binary" });
});

test("registry rejects duplicate operationIds", () => {
  const reg = new Registry();
  const def = { method: "GET" as const, path: "/a", operationId: "dup", summary: "", tags: [], response: z.object({}) };
  reg.register(def);
  expect(() => reg.register(def)).toThrow(/duplicate/);
});
