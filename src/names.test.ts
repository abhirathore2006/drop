import { test, expect } from "bun:test";
import { validateName } from "./names.ts";

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
