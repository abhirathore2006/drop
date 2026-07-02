import { test, expect } from "bun:test";
import { sanitizeDatabaseConfig, parseDatabaseConfig, validateDbPassword, generateDbPassword, validateDbStorage } from "./db-config.ts";

test("validateDbPassword: accepts strong printable passwords, rejects short/whitespace/quotes/non-strings", () => {
  expect(validateDbPassword("a-valid-password-123")).toBeNull();
  expect(validateDbPassword("Aa1!#$%&()*+,-./:")).toBeNull();
  expect(validateDbPassword("short")).not.toBeNull(); // < 12
  expect(validateDbPassword("has a space in it!")).not.toBeNull(); // whitespace
  expect(validateDbPassword('has"quote"chars')).not.toBeNull(); // quote
  expect(validateDbPassword("back\\slash\\here")).not.toBeNull(); // backslash
  expect(validateDbPassword(12345678901234)).not.toBeNull(); // non-string
  expect(validateDbPassword("x".repeat(129))).not.toBeNull(); // > 128
  expect(validateDbPassword("aaaaaaaaaaaa")).not.toBeNull(); // 12 chars but only 1 distinct → too weak
  expect(validateDbPassword("ababababab12")).not.toBeNull(); // only 4 distinct → too weak
  expect(validateDbPassword("0123456789ab")).toBeNull(); // plenty distinct
});

test("generateDbPassword: returns a strong password that always passes validation", () => {
  for (let i = 0; i < 50; i++) {
    const pw = generateDbPassword();
    expect(pw.length).toBeGreaterThanOrEqual(12);
    expect(validateDbPassword(pw)).toBeNull();
  }
  expect(generateDbPassword()).not.toBe(generateDbPassword()); // random
});

test("sanitizeDatabaseConfig: empty object → engine + storage + hibernation defaults", () => {
  const c = sanitizeDatabaseConfig({})!;
  expect(c.engine).toBe("postgres-18");
  expect(c.storage).toBe("1Gi"); // default sits at the cap
  expect(c.hibernation).toBe("none");
  expect(c.name).toBeUndefined();
});

test("sanitizeDatabaseConfig: a bare/null database section still yields a default DB", () => {
  const c = sanitizeDatabaseConfig(null)!;
  expect(c.engine).toBe("postgres-18");
  expect(c.storage).toBe("1Gi");
});

test("sanitizeDatabaseConfig: accepts a valid storage quantity + scheduled hibernation + name", () => {
  const c = sanitizeDatabaseConfig({ name: "billing-db", storage: "512Mi", hibernation: "scheduled" })!;
  expect(c.name).toBe("billing-db");
  expect(c.storage).toBe("512Mi");
  expect(c.hibernation).toBe("scheduled");
});

test("sanitizeDatabaseConfig: bad or over-cap storage falls back to the default (clamp)", () => {
  expect(sanitizeDatabaseConfig({ storage: "10 gigs" })!.storage).toBe("1Gi"); // malformed → default
  expect(sanitizeDatabaseConfig({ storage: "500Mi" })!.storage).toBe("500Mi"); // within cap → kept
  expect(sanitizeDatabaseConfig({ storage: "1Gi" })!.storage).toBe("1Gi"); // exactly the cap → kept
  expect(sanitizeDatabaseConfig({ storage: "20Gi" })!.storage).toBe("1Gi"); // over cap → clamped to default
  expect(sanitizeDatabaseConfig({ storage: "1Ti" })!.storage).toBe("1Gi"); // over cap → clamped to default
});

test("validateDbStorage: caps requests at 1Gi with a clear error; absent/within-cap → null", () => {
  expect(validateDbStorage({})).toBeNull(); // no storage requested → default applies
  expect(validateDbStorage({ storage: "1Gi" })).toBeNull(); // at the cap
  expect(validateDbStorage({ storage: "512Mi" })).toBeNull(); // under the cap
  expect(validateDbStorage({ storage: "2Gi" })).toMatch(/exceeds the 1Gi/); // over the cap
  expect(validateDbStorage({ storage: "1Ti" })).toMatch(/exceeds the 1Gi/);
  expect(validateDbStorage({ storage: "10 gigs" })).toMatch(/invalid storage/); // malformed
  expect(validateDbStorage({ storage: 5 })).toMatch(/invalid storage/); // non-string
});

test("sanitizeDatabaseConfig: pins engine to postgres-18 (v1 only supports it)", () => {
  expect(sanitizeDatabaseConfig({ engine: "postgres-16" })!.engine).toBe("postgres-18");
  expect(sanitizeDatabaseConfig({ engine: "mysql" })!.engine).toBe("postgres-18");
});

test("sanitizeDatabaseConfig: ignores an invalid name (keeps it unset, not throwing)", () => {
  expect(sanitizeDatabaseConfig({ name: "Bad Name!" })!.name).toBeUndefined();
});

test("sanitizeDatabaseConfig: a non-object scalar input → undefined", () => {
  expect(sanitizeDatabaseConfig("postgres")).toBeUndefined();
  expect(sanitizeDatabaseConfig(42)).toBeUndefined();
});

test("parseDatabaseConfig: extracts the database: section of drop.yaml", () => {
  const text = `database:\n  name: billing-db\n  storage: 512Mi\n  hibernation: scheduled\n`;
  const c = parseDatabaseConfig(text)!;
  expect(c.name).toBe("billing-db");
  expect(c.storage).toBe("512Mi");
  expect(c.hibernation).toBe("scheduled");
});

test("parseDatabaseConfig: rejects an over-cap storage request up front (throws)", () => {
  expect(() => parseDatabaseConfig(`database:\n  storage: 20Gi\n`)).toThrow(/exceeds the 1Gi/);
});

test("parseDatabaseConfig: a bare `database:` key (null) still makes a default DB", () => {
  const c = parseDatabaseConfig("database:\n")!;
  expect(c.engine).toBe("postgres-18");
  expect(c.storage).toBe("1Gi");
});

test("parseDatabaseConfig: no database: section → undefined", () => {
  expect(parseDatabaseConfig("app:\n  image: x:1\n")).toBeUndefined();
  expect(parseDatabaseConfig("site: {}\n")).toBeUndefined();
});
