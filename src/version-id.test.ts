import { test, expect } from "bun:test";
import { newVersionId } from "./version-id.ts";

test("sortable and unique", () => {
  const t1 = new Date("2026-06-10T10:00:00Z");
  const t2 = new Date("2026-06-10T10:00:01Z");
  expect(newVersionId(t1) < newVersionId(t2)).toBe(true);
  expect(newVersionId(t1)).not.toBe(newVersionId(t1)); // random suffix differs
});
