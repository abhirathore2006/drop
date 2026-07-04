import { test, expect, describe } from "bun:test";
import { substituteTemplate, sanitizeVariables, validateVarKey, extractVarKeys, resolveEnvSpec, type TemplateVariable } from "./vars.ts";
import type { StackSpec } from "../stack-config.ts";

const vars = (a: TemplateVariable[]): TemplateVariable[] => a;

describe("substituteTemplate", () => {
  test("replaces ${var.x} across nested string values and sets the stack name", () => {
    const spec: StackSpec = {
      name: "tpl",
      resources: {
        db: { type: "database", storage: "${var.db_storage}" },
        api: { type: "app", image: "api:1", uses: [{ database: "db" }], env: { PGHOST: "${stack}-db-rw", REGION: "${var.region}" } },
      },
    };
    const r = substituteTemplate(spec, vars([
      { key: "db_storage", required: false, default: "1Gi" },
      { key: "region", required: true },
    ]), { region: "eu-west" }, "shop");
    expect(r.missing).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.spec.name).toBe("shop");
    expect(r.spec.resources.db!.storage).toBe("1Gi");
    // ${stack} resolved to the target stack name; nested env var substituted
    expect(r.spec.resources.api!.env).toEqual({ PGHOST: "shop-db-rw", REGION: "eu-west" });
    expect(r.secretsToSet).toEqual([]);
  });

  test("an explicit --set value wins over the declared default", () => {
    const spec: StackSpec = { name: "t", resources: { api: { type: "app", image: "x:1", env: { SIZE: "${var.size}" } } } };
    const r = substituteTemplate(spec, vars([{ key: "size", required: false, default: "small" }]), { size: "large" }, "s");
    expect(r.spec.resources.api!.env!.SIZE).toBe("large");
  });

  test("missing required variable (no value, no default) → reported in `missing`", () => {
    const spec: StackSpec = { name: "t", resources: { api: { type: "app", image: "x:1", env: { REGION: "${var.region}" } } } };
    const r = substituteTemplate(spec, vars([{ key: "region", required: true }]), {}, "s");
    expect(r.missing).toEqual(["region"]);
  });

  test("a secret variable used as a WHOLE env value is lifted to secretsToSet and removed from the spec", () => {
    const spec: StackSpec = {
      name: "t",
      resources: { web: { type: "app", image: "web:1", env: { SESSION_SECRET: "${var.session}", NODE_ENV: "production" } } },
    };
    const r = substituteTemplate(spec, vars([{ key: "session", required: true, secret: true }]), { session: "s3cr3t-value" }, "myapp");
    expect(r.missing).toEqual([]);
    expect(r.errors).toEqual([]);
    // SESSION_SECRET NEVER lands in the spec; NODE_ENV survives
    expect(r.spec.resources.web!.env).toEqual({ NODE_ENV: "production" });
    expect(r.secretsToSet).toEqual([{ resourceKey: "web", envKey: "SESSION_SECRET", value: "s3cr3t-value" }]);
  });

  test("a secret variable used INSIDE a larger string (not a whole env value) is an error", () => {
    const spec: StackSpec = { name: "t", resources: { web: { type: "app", image: "w:1", env: { URL: "https://x?token=${var.tok}" } } } };
    const r = substituteTemplate(spec, vars([{ key: "tok", required: true, secret: true }]), { tok: "abc" }, "s");
    expect(r.errors.some((e) => /secret variable "tok"/.test(e))).toBe(true);
  });

  test("an unknown variable reference is an error", () => {
    const spec: StackSpec = { name: "t", resources: { api: { type: "app", image: "x:1", env: { A: "${var.nope}" } } } };
    const r = substituteTemplate(spec, vars([]), {}, "s");
    expect(r.errors.some((e) => /unknown variable "nope"/.test(e))).toBe(true);
  });

  test("a required secret with no value is reported missing and NOT emitted as a secret", () => {
    const spec: StackSpec = { name: "t", resources: { web: { type: "app", image: "w:1", env: { PW: "${var.pw}" } } } };
    const r = substituteTemplate(spec, vars([{ key: "pw", required: true, secret: true }]), {}, "s");
    expect(r.missing).toEqual(["pw"]);
    expect(r.secretsToSet).toEqual([]);
  });
});

describe("sanitizeVariables", () => {
  test("accepts a well-formed array and drops unknown fields", () => {
    const r = sanitizeVariables([{ key: "region", description: "AWS region", default: "us", required: true, junk: 1 }, { key: "pw", required: true, secret: true }]);
    expect(r).toEqual([
      { key: "region", required: true, description: "AWS region", default: "us" },
      { key: "pw", required: true, secret: true },
    ]);
  });
  test("rejects a bad key, a duplicate, and a non-array", () => {
    expect(typeof sanitizeVariables([{ key: "1bad", required: false }])).toBe("string");
    expect(typeof sanitizeVariables([{ key: "a", required: false }, { key: "a", required: true }])).toBe("string");
    expect(typeof sanitizeVariables("nope")).toBe("string");
  });
});

test("validateVarKey", () => {
  expect(validateVarKey("DB_URL")).toBeNull();
  expect(validateVarKey("1x")).not.toBeNull();
  expect(validateVarKey("")).not.toBeNull();
});

// (E3) env variable overlay: extractVarKeys finds referenced ${var.…} (not ${stack}); resolveEnvSpec
// substitutes an env's { key: value } overlay, reporting a referenced-but-unprovided variable as missing.
describe("E3 env overlay (extractVarKeys / resolveEnvSpec)", () => {
  const spec: StackSpec = {
    name: "shop",
    resources: {
      db: { type: "database", storage: "${var.size}" },
      api: { type: "app", image: "x:1", env: { GREETING: "${var.greeting}", HOST: "${stack}-db-rw" } },
    },
  };

  test("extractVarKeys returns the distinct ${var.…} keys, excluding ${stack}", () => {
    expect(extractVarKeys(spec).sort()).toEqual(["greeting", "size"]);
    expect(extractVarKeys({ name: "x", resources: { a: { type: "app", image: "x:1" } } })).toEqual([]);
  });

  test("resolveEnvSpec substitutes the overlay (typed + env values) and resolves ${stack}", () => {
    const r = resolveEnvSpec(spec, { size: "512Mi", greeting: "hi" }, "shop");
    expect(r.missing).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.spec.resources.db!.storage).toBe("512Mi");
    expect(r.spec.resources.api!.env!.GREETING).toBe("hi");
    expect(r.spec.resources.api!.env!.HOST).toBe("shop-db-rw");
  });

  test("resolveEnvSpec reports a referenced-but-unprovided variable as missing", () => {
    const r = resolveEnvSpec(spec, { size: "512Mi" }, "shop"); // greeting not provided
    expect(r.missing).toContain("greeting");
  });

  test("resolveEnvSpec on a placeholder-free spec is a no-op", () => {
    const concrete: StackSpec = { name: "shop", resources: { db: { type: "database", storage: "512Mi" } } };
    const r = resolveEnvSpec(concrete, {}, "shop");
    expect(r.missing).toEqual([]);
    expect(r.spec.resources.db!.storage).toBe("512Mi");
  });
});
