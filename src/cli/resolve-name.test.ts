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
  const d = dirWith({ "drop.yaml": "site:\n  name: fromfile\n" });
  expect(await resolveSiteName(d, "fromarg")).toEqual({ name: "fromarg", source: "arg" });
});

test("falls back to drop.yaml site.name", async () => {
  const d = dirWith({ "drop.yaml": "site:\n  name: siteb\n  spaFallback: index.html\n" });
  expect(await resolveSiteName(d)).toEqual({ name: "siteb", source: "drop.yaml" });
});

test("generates when no arg and no drop.yaml name", async () => {
  const d = dirWith({ "index.html": "<html>" });
  const r = await resolveSiteName(d);
  expect(r.source).toBe("generated");
  expect(r.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
});

test("invalid explicit name throws", async () => {
  const d = dirWith({});
  await expect(resolveSiteName(d, "Bad_Name")).rejects.toThrow();
});

import { loadAppDeploy } from "./resolve-name.ts";

test("loadAppDeploy reads the app: section and resolves name from app.name", async () => {
  const d = dirWith({ "drop.yaml": "app:\n  name: billing\n  image: ecr/billing:v1\n" });
  const r = await loadAppDeploy(d);
  expect(r).toMatchObject({ name: "billing", source: "drop.yaml" });
  expect(r.app.image).toBe("ecr/billing:v1");
});

test("loadAppDeploy: arg name wins; generates when no name", async () => {
  const d = dirWith({ "drop.yaml": "app:\n  image: ecr/x:1\n" });
  expect((await loadAppDeploy(d, "billing")).name).toBe("billing");
  const gen = await loadAppDeploy(d);
  expect(gen.source).toBe("generated");
  expect(gen.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
});

test("loadAppDeploy throws when no app: section / no drop.yaml", async () => {
  await expect(loadAppDeploy(dirWith({ "drop.yaml": "site:\n  name: s\n" }))).rejects.toThrow(/app:/);
  await expect(loadAppDeploy(dirWith({ "index.html": "x" }))).rejects.toThrow(/no drop.yaml/);
});
