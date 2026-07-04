import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { stackNameFromDir, serializeDetectedStack, writeDetectedStack } from "./detect.ts";
import type { DetectedSpec } from "../detect/detect.ts";

function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "drop-detect-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}

// ---------------------------------------------------------------------------------------------
// stackNameFromDir
// ---------------------------------------------------------------------------------------------

test("stackNameFromDir sanitizes to a DNS label", () => {
  const d = mkdtempSync(join(tmpdir(), "My_Cool App-"));
  expect(stackNameFromDir(d)).toMatch(/^[a-z0-9-]+$/);
});

test("stackNameFromDir falls back off a reserved word", () => {
  const d = join(tmpdir(), "drop-detect-reserved-fixture", "api");
  mkdirSync(d, { recursive: true });
  expect(stackNameFromDir(d)).toBe("api-stack");
});

// ---------------------------------------------------------------------------------------------
// serializeDetectedStack
// ---------------------------------------------------------------------------------------------

test("serializeDetectedStack renders type/dir/uses in the hand-written style", () => {
  const spec: DetectedSpec = {
    name: "myapp",
    resources: {
      app: { type: "app", dir: ".", uses: [{ database: "db" }, { cache: "cache" }] },
      cache: { type: "cache" },
      db: { type: "database" },
    },
  };
  const out = serializeDetectedStack(spec);
  expect(out).toBe(
    [
      "stack:",
      "  name: myapp",
      "  resources:",
      "    app:",
      "      type: app",
      "      dir: .",
      "      uses: [{ database: db }, { cache: cache }]",
      "    cache:",
      "      type: cache",
      "    db:",
      "      type: database",
      "",
    ].join("\n"),
  );
});

test("serializeDetectedStack sorts resource keys regardless of input order", () => {
  const spec: DetectedSpec = { name: "x", resources: { zeta: { type: "app", dir: "." }, alpha: { type: "database" } } };
  const lines = serializeDetectedStack(spec).split("\n");
  expect(lines.indexOf("    alpha:")).toBeLessThan(lines.indexOf("    zeta:"));
});

// ---------------------------------------------------------------------------------------------
// writeDetectedStack
// ---------------------------------------------------------------------------------------------

const SPEC: DetectedSpec = { name: "myapp", resources: { app: { type: "app", dir: "." } } };

test("creates a fresh drop.yaml when none exists", async () => {
  const d = mkdtempSync(join(tmpdir(), "drop-detect-"));
  const { path, created } = await writeDetectedStack(d, SPEC);
  expect(created).toBe(true);
  const text = readFileSync(path, "utf8");
  expect(text).toContain("stack:");
  expect(text).toContain("name: myapp");
});

test("appends to an existing drop.yaml with no stack: section, preserving it byte-for-byte", async () => {
  const d = dirWith({ "drop.yaml": "app:\n  name: existing\n  image: x:1\n" });
  const { created } = await writeDetectedStack(d, SPEC);
  expect(created).toBe(false);
  const text = readFileSync(join(d, "drop.yaml"), "utf8");
  expect(text).toContain("app:\n  name: existing\n  image: x:1");
  expect(text).toContain("stack:\n  name: myapp");
});

test("refuses to overwrite an existing stack: section without --force", async () => {
  const d = dirWith({ "drop.yaml": "stack:\n  name: old\n  resources:\n    db: { type: database }\n" });
  await expect(writeDetectedStack(d, SPEC)).rejects.toThrow(/already has a stack: section/);
  // unchanged
  expect(readFileSync(join(d, "drop.yaml"), "utf8")).toContain("name: old");
});

test("--force replaces the stack: section while preserving other sections", async () => {
  const d = dirWith({
    "drop.yaml": ["app:", "  name: existing", "  image: x:1", "", "stack:", "  name: old", "  resources:", "    db: { type: database }", ""].join("\n"),
  });
  await writeDetectedStack(d, SPEC, { force: true });
  const text = readFileSync(join(d, "drop.yaml"), "utf8");
  expect(text).toContain("app:\n  name: existing\n  image: x:1");
  expect(text).toContain("name: myapp");
  expect(text).not.toContain("name: old");
  expect(text).not.toContain("db: { type: database }");
});

test("--force replaces stack: even when it is followed by another top-level section", async () => {
  const d = dirWith({
    "drop.yaml": ["stack:", "  name: old", "  resources:", "    db: { type: database }", "", "site:", "  spaFallback: false", ""].join("\n"),
  });
  await writeDetectedStack(d, SPEC, { force: true });
  const text = readFileSync(join(d, "drop.yaml"), "utf8");
  expect(text).toContain("name: myapp");
  expect(text).not.toContain("name: old");
  expect(text).toContain("site:\n  spaFallback: false");
});
