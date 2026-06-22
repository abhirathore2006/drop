import { test, expect } from "bun:test";
import { sanitizeDatabaseConfig, parseDatabaseConfig, validateDbPassword, generateDbPassword } from "./db-config.ts";

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
  expect(c.storage).toBe("10Gi");
  expect(c.hibernation).toBe("none");
  expect(c.name).toBeUndefined();
});

test("sanitizeDatabaseConfig: a bare/null database section still yields a default DB", () => {
  const c = sanitizeDatabaseConfig(null)!;
  expect(c.engine).toBe("postgres-18");
  expect(c.storage).toBe("10Gi");
});

test("sanitizeDatabaseConfig: accepts a valid storage quantity + scheduled hibernation + name", () => {
  const c = sanitizeDatabaseConfig({ name: "billing-db", storage: "20Gi", hibernation: "scheduled" })!;
  expect(c.name).toBe("billing-db");
  expect(c.storage).toBe("20Gi");
  expect(c.hibernation).toBe("scheduled");
});

test("sanitizeDatabaseConfig: rejects a bad storage quantity (falls back to default)", () => {
  expect(sanitizeDatabaseConfig({ storage: "10 gigs" })!.storage).toBe("10Gi");
  expect(sanitizeDatabaseConfig({ storage: "500Mi" })!.storage).toBe("500Mi");
  expect(sanitizeDatabaseConfig({ storage: "1Ti" })!.storage).toBe("1Ti");
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
  const text = `database:\n  name: billing-db\n  storage: 20Gi\n  hibernation: scheduled\n`;
  const c = parseDatabaseConfig(text)!;
  expect(c.name).toBe("billing-db");
  expect(c.storage).toBe("20Gi");
  expect(c.hibernation).toBe("scheduled");
});

test("parseDatabaseConfig: a bare `database:` key (null) still makes a default DB", () => {
  const c = parseDatabaseConfig("database:\n")!;
  expect(c.engine).toBe("postgres-18");
  expect(c.storage).toBe("10Gi");
});

test("parseDatabaseConfig: no database: section → undefined", () => {
  expect(parseDatabaseConfig("app:\n  image: x:1\n")).toBeUndefined();
  expect(parseDatabaseConfig("site: {}\n")).toBeUndefined();
});
