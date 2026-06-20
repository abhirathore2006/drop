import { test, expect } from "bun:test";
import { sanitizeAppConfig, parseAppConfig, assertHttpOnly } from "./app-config.ts";

test("sanitizeAppConfig requires an image", () => {
  expect(sanitizeAppConfig({})).toBeUndefined();
  expect(sanitizeAppConfig({ name: "x" })).toBeUndefined();
  expect(sanitizeAppConfig("nope")).toBeUndefined();
  expect(sanitizeAppConfig(undefined)).toBeUndefined();
});

test("sanitizeAppConfig parses image, name, resources, env, services, scale; drops junk", () => {
  const c = sanitizeAppConfig({
    name: "billing",
    image: "ecr/billing:v1",
    resources: { cpu: "0.5", memory: "512Mi" },
    env: { NODE_ENV: "production", BAD: 123 },
    services: [{ internal_port: 8080, protocol: "http" }],
    scale: { min: 0, max: 3 },
    junk: true,
  })!;
  expect(c.image).toBe("ecr/billing:v1");
  expect(c.name).toBe("billing");
  expect(c.resources).toEqual({ cpu: "0.5", memory: "512Mi" });
  expect(c.env).toEqual({ NODE_ENV: "production" }); // non-string dropped
  expect(c.services).toEqual([{ internalPort: 8080, protocol: "http" }]);
  expect(c.scale).toEqual({ min: 0, max: 3 });
  expect((c as any).junk).toBeUndefined();
});

test("sanitizeAppConfig defaults services to one http port 8080", () => {
  expect(sanitizeAppConfig({ image: "x:1" })!.services).toEqual([{ internalPort: 8080, protocol: "http" }]);
});

test("sanitizeAppConfig ignores an invalid name and a malformed scale", () => {
  const c = sanitizeAppConfig({ image: "x:1", name: "Bad_Name", scale: { min: 5, max: 2 } })!;
  expect(c.name).toBeUndefined(); // failed validateName
  expect(c.scale).toBeUndefined(); // max < min
});

test("parseAppConfig reads the app: section; undefined when absent", () => {
  const c = parseAppConfig("app:\n  image: ecr/x:1\n  scale: { min: 0, max: 3 }\n")!;
  expect(c.image).toBe("ecr/x:1");
  expect(c.scale).toEqual({ min: 0, max: 3 });
  expect(parseAppConfig("site:\n  name: s\n")).toBeUndefined();
  expect(parseAppConfig("")).toBeUndefined();
});

test("assertHttpOnly enforces the v1 443-only rule (one http service)", () => {
  expect(() => assertHttpOnly({ image: "x", services: [{ internalPort: 8080, protocol: "http" }] })).not.toThrow();
  expect(() => assertHttpOnly({ image: "x", services: [{ internalPort: 5432, protocol: "tcp" }] })).toThrow(/tcp/i);
  expect(() =>
    assertHttpOnly({
      image: "x",
      services: [
        { internalPort: 80, protocol: "http" },
        { internalPort: 81, protocol: "http" },
      ],
    }),
  ).toThrow(/one service/i);
});
