import { test, expect } from "bun:test";
import { hashBreakGlass, parseBreakGlass, verifyBreakGlass } from "./break-glass.ts";

test("hashBreakGlass → verifyBreakGlass roundtrips the correct password (scrypt)", () => {
  const spec = hashBreakGlass("admin@example.com", "correct horse battery staple");
  expect(spec.split(":")).toHaveLength(3); // email:saltHex:hashHex
  expect(verifyBreakGlass(spec, "admin@example.com", "correct horse battery staple")).toBe("admin@example.com");
});

test("verifyBreakGlass rejects a wrong password and a wrong email", () => {
  const spec = hashBreakGlass("admin@example.com", "s3cret");
  expect(verifyBreakGlass(spec, "admin@example.com", "nope")).toBeNull();
  expect(verifyBreakGlass(spec, "someone@else.com", "s3cret")).toBeNull();
});

test("verifyBreakGlass is disabled (returns null) when the spec is unset or malformed", () => {
  expect(verifyBreakGlass(undefined, "admin@example.com", "x")).toBeNull();
  expect(verifyBreakGlass("", "admin@example.com", "x")).toBeNull();
  expect(verifyBreakGlass("no-colons", "admin@example.com", "x")).toBeNull();
  expect(verifyBreakGlass("admin@example.com:onlysalt", "admin@example.com", "x")).toBeNull();
});

test("verifyBreakGlass matches the email case-insensitively", () => {
  const spec = hashBreakGlass("Admin@Example.com", "pw");
  expect(parseBreakGlass(spec)?.email).toBe("admin@example.com"); // stored lowercased
  expect(verifyBreakGlass(spec, "ADMIN@example.COM", "pw")).toBe("admin@example.com");
});
