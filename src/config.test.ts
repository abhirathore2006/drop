import { test, expect } from "bun:test";
import { loadConfig } from "./config.ts";

const BASE = { DROP_S3_BUCKET: "drop-sites", DROP_DATABASE_URL: "postgres://x/y" };

test("loadConfig reads env and applies defaults", () => {
  const c = loadConfig(BASE);
  expect(c.s3Bucket).toBe("drop-sites");
  expect(c.databaseUrl).toBe("postgres://x/y");
  expect(c.httpPort).toBe(8080);
  expect(c.baseDomain).toBe("drop.example.com");
  expect(c.keepVersions).toBe(10);
  expect(c.allowedDomains).toEqual([]);
  expect(c.devAuth).toBe(false);
});

test("loadConfig parses allowed domains and dev auth", () => {
  const c = loadConfig({
    ...BASE,
    DROP_ALLOWED_DOMAINS: "example.com, example.org",
    DROP_DEV_AUTH: "1",
  });
  expect(c.allowedDomains).toEqual(["example.com", "example.org"]);
  expect(c.devAuth).toBe(true);
});

test("loadConfig throws when bucket missing", () => {
  expect(() => loadConfig({ DROP_DATABASE_URL: "postgres://x/y" })).toThrow();
});

test("loadConfig throws when database url missing", () => {
  expect(() => loadConfig({ DROP_S3_BUCKET: "b" })).toThrow();
});
