// (F2) Pure lockstep test: the hand-written stack schema (schema.ts) must track what sanitizeStackConfig
// actually accepts (stack-config.ts). We sanitize a MAXIMAL spec (one resource of every type, carrying every
// field) and assert every field the sanitizer keeps is advertised by STACK_RESOURCE_FIELDS — so a new
// accepted field landing server-side breaks THIS test rather than silently dropping out of the prompt.
import { test, expect } from "bun:test";
import { sanitizeStackConfig } from "../stack-config.ts";
import { STACK_JSON_SCHEMA, STACK_RESOURCE_FIELDS, STACK_RESOURCE_KINDS } from "./schema.ts";

test("STACK_RESOURCE_KINDS matches sanitizeStackConfig's accepted types (each round-trips)", () => {
  for (const type of STACK_RESOURCE_KINDS) {
    const input = { name: "stk", resources: { r: kindSample(type) } };
    const out = sanitizeStackConfig(input);
    expect(out, `type "${type}" should sanitize into a resource`).toBeDefined();
    expect(out!.resources.r?.type).toBe(type);
  }
});

test("every field sanitizeStackConfig keeps is advertised by STACK_RESOURCE_FIELDS", () => {
  const maximal = {
    name: "stk",
    resources: {
      db: { type: "database", storage: "1Gi", hibernation: "none", name: "stk-db" },
      cache: { type: "cache", memory: "256Mi", persistent: true },
      files: { type: "bucket" },
      api: {
        type: "app",
        image: "ghcr.io/x/api:1",
        dir: "./api",
        env: { NODE_ENV: "production" },
        services: [{ internalPort: 8080, protocol: "http" }],
        resources: { cpu: "500m", memory: "512Mi" },
        scale: { min: 1, max: 3 },
        trusted: true,
        uses: [{ database: "db" }, { cache: "cache" }, { bucket: "files" }],
        healthcheck: { path: "/health", interval: "10s" },
        release: { command: "npm run migrate" },
        processes: { web: { web: true }, worker: { command: "npm run worker" } },
        expose: { tcp: false },
      },
      auth: { type: "auth", db: "db", providers: {}, redirect_urls: ["https://x/cb"], jwt_ttl: "1h", signup: "invite", site_url: "https://x", rbac: true },
      web: { type: "site", dir: "./dist", env: { A: "b" }, env_from: [{ resource: "api", output: "url", as: "API_URL" }] },
    },
  };
  const out = sanitizeStackConfig(maximal);
  expect(out).toBeDefined();
  const advertised = new Set<string>(STACK_RESOURCE_FIELDS);
  const emitted = new Set<string>();
  for (const res of Object.values(out!.resources)) for (const k of Object.keys(res)) emitted.add(k);
  const missing = [...emitted].filter((k) => !advertised.has(k));
  expect(missing, `sanitizeStackConfig emits fields the schema doesn't advertise: ${missing.join(", ")}`).toEqual([]);
});

test("STACK_JSON_SCHEMA is a well-formed object schema with name + resources", () => {
  expect(STACK_JSON_SCHEMA.type).toBe("object");
  expect(Object.keys(STACK_JSON_SCHEMA.properties)).toContain("name");
  expect(Object.keys(STACK_JSON_SCHEMA.properties)).toContain("resources");
});

function kindSample(type: string): Record<string, unknown> {
  switch (type) {
    case "database":
      return { type, storage: "1Gi" };
    case "cache":
      return { type, memory: "256Mi" };
    case "bucket":
      return { type };
    case "auth":
      return { type, db: "d" }; // db is a KEY reference; structural sanitize keeps it (edge validation is separate)
    case "app":
      return { type, image: "ghcr.io/x/api:1" };
    default:
      return { type, dir: "./dist" }; // site
  }
}
