import { test, expect } from "bun:test";
import { validateName, generateName } from "./names.ts";

test("accepts valid labels", () => {
  for (const n of ["myapp", "my-app", "a", "app123", "a-b-c"]) {
    expect(validateName(n)).toBeNull();
  }
});

test("rejects invalid / reserved labels", () => {
  const bad = ["", "-app", "app-", "App", "my_app", "white space", "www", "api", "drop", "a".repeat(64)];
  for (const n of bad) {
    expect(validateName(n)).not.toBeNull();
  }
});

test("generateName produces valid, varied names", () => {
  const names = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const n = generateName();
    expect(validateName(n)).toBeNull(); // always a valid site name
    expect(n).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    names.add(n);
  }
  expect(names.size).toBeGreaterThan(480); // ~no collisions over 500
});
