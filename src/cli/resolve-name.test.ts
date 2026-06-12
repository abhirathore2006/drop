import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolveSiteName } from "./resolve-name.ts";

function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "drop-rn-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}

test("explicit arg wins", async () => {
  const d = dirWith({ "_drop.json": JSON.stringify({ name: "fromfile" }) });
  expect(await resolveSiteName(d, "fromarg")).toEqual({ name: "fromarg", source: "arg" });
});

test("falls back to _drop.json name", async () => {
  const d = dirWith({ "_drop.json": JSON.stringify({ name: "siteb", spaFallback: "index.html" }) });
  expect(await resolveSiteName(d)).toEqual({ name: "siteb", source: "_drop.json" });
});

test("generates when no arg and no _drop.json name", async () => {
  const d = dirWith({ "index.html": "<html>" });
  const r = await resolveSiteName(d);
  expect(r.source).toBe("generated");
  expect(r.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
});

test("invalid explicit name throws", async () => {
  const d = dirWith({});
  await expect(resolveSiteName(d, "Bad_Name")).rejects.toThrow();
});
