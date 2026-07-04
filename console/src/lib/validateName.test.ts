// Locks the console's validateName mirror to the server's real implementation
// (../../../src/names.ts) over a shared sweep of inputs — the same "mirror + shared-table
// test" pattern console/src/lib/status.test.ts uses for status.ts. Node-side test; no
// happy-dom needed. Importing the real src/names.ts here (under plain `bun test`, i.e.
// real Node/Bun, not a browser bundle) is fine — see validateName.ts's header comment for
// why the console can't import it directly at runtime.
import { describe, expect, test } from "bun:test";
import { validateName as serverValidateName } from "../../../src/names.ts";
import { validateName } from "./validateName.ts";

const SWEEP = [
  "",
  "a",
  "ab",
  "a1",
  "a-b",
  "-abc",
  "abc-",
  "ABC",
  "a_b",
  "a.b",
  "a b",
  "www",
  "api",
  "admin",
  "drop",
  "app",
  "edge",
  "internal",
  "static",
  "my-cool-site",
  "twilight-cherry-8f3a",
  "a".repeat(63),
  "a".repeat(64),
  "1abc",
  "a1-2b3",
  "a".repeat(0),
  "foo--bar",
  "a--b",
  "myapp--pr-1",
  "a---b",
];

describe("validateName mirrors src/names.ts exactly", () => {
  for (const name of SWEEP) {
    test(`agrees on ${JSON.stringify(name)}`, () => {
      expect(validateName(name)).toBe(serverValidateName(name));
    });
  }
});
