import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { migrateConfig } from "./migrate-config.ts";

test("migrateConfig writes _drop.json content under site: in drop.yaml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drop-mc-"));
  await writeFile(join(dir, "_drop.json"), JSON.stringify({ spaFallback: false, name: "rep" }));
  const r = await migrateConfig(dir);
  expect(r).toEqual({ written: join(dir, "drop.yaml") });
  const doc = parseYaml(await readFile(join(dir, "drop.yaml"), "utf8"));
  expect(doc).toEqual({ site: { name: "rep", spaFallback: false } });
});

test("migrateConfig refuses to overwrite an existing drop.yaml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drop-mc-"));
  await writeFile(join(dir, "_drop.json"), JSON.stringify({ name: "rep" }));
  await writeFile(join(dir, "drop.yaml"), "site:\n  name: existing\n");
  expect(await migrateConfig(dir)).toEqual({ skipped: join(dir, "drop.yaml") });
});
