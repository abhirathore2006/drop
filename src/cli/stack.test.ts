import { test, expect } from "bun:test";
import { formatStackDiff } from "./stack.ts";
import { buildProgram } from "./commands.ts";

// The three-way diff shape the server emits (src/stacks/diff.ts) — a small local fixture.
const diff = {
  upstreamChanged: true,
  hasLocalDrift: true,
  conflicts: ["db"],
  resources: [
    { key: "db", class: "conflict", conflict: true, badge: "conflict", fields: [{ field: "storage", class: "conflict" as const, pinned: "1Gi", latest: "512Mi", current: "256Mi" }], inPinned: true, inLatest: true, inCurrent: true },
    { key: "api", class: "upstream-only", conflict: false, badge: "changed", fields: [{ field: "image", class: "upstream-only" as const, pinned: "web:1", latest: "web:2" }], inPinned: true, inLatest: true, inCurrent: true },
    { key: "logs", class: "local-only", conflict: false, badge: "unchanged", fields: [{ field: "storage", class: "local-only" as const, pinned: "1Gi", current: "2Gi" }], inPinned: true, inLatest: true, inCurrent: true },
    { key: "cache", class: "added-upstream", conflict: false, badge: "added", fields: [], inPinned: false, inLatest: true, inCurrent: false },
    { key: "old", class: "removed-upstream", conflict: false, badge: "removed", fields: [], inPinned: true, inLatest: false, inCurrent: true },
    { key: "keep", class: "unchanged", conflict: false, badge: "unchanged", fields: [], inPinned: true, inLatest: true, inCurrent: true },
  ],
};

test("formatStackDiff renders upstream vs local vs conflict per key, and a resolution hint", () => {
  const out = formatStackDiff(diff as any);
  // an unchanged key is omitted (its row header never renders); every changed key appears
  expect(out).not.toContain("keep  [");
  expect(out).toContain("db  [");
  expect(out).toContain("conflict");
  // upstream-only shows pinned → latest tagged (upstream); local-only shows the local drift
  expect(out).toContain("image: web:1 → web:2  (upstream)");
  expect(out).toContain("storage: 1Gi → 2Gi  (local drift)");
  // a conflict lists all three axes
  expect(out).toContain("pinned=1Gi");
  expect(out).toContain("latest=512Mi");
  expect(out).toContain("local=256Mi");
  // add / remove semantics + a resolution hint
  expect(out).toContain("added upstream");
  expect(out).toContain("removed upstream");
  expect(out).toContain("--take-upstream");
  expect(out).toContain("--keep-local");
});

test("formatStackDiff on a clean diff says up to date", () => {
  const clean = { upstreamChanged: false, hasLocalDrift: false, conflicts: [], resources: [{ key: "db", class: "unchanged", conflict: false, badge: "unchanged", fields: [], inPinned: true, inLatest: true, inCurrent: true }] };
  expect(formatStackDiff(clean as any)).toContain("no upstream changes");
});

test("`drop stack` has outdated + upgrade subcommands with their resolution flags", () => {
  const p = buildProgram();
  const stack = p.commands.find((c) => c.name() === "stack")!;
  const subs = stack.commands.map((c) => c.name());
  expect(subs).toContain("outdated");
  expect(subs).toContain("upgrade");

  const upgrade = stack.commands.find((c) => c.name() === "upgrade")!;
  for (const o of ["--to", "--take-upstream", "--keep-local", "--dry-run", "--prune", "--org"]) {
    expect(upgrade.options.some((x) => x.long === o)).toBe(true);
  }
  // outdated takes an OPTIONAL name (list-all when omitted)
  const outdated = stack.commands.find((c) => c.name() === "outdated")!;
  expect(outdated.registeredArguments.some((a: any) => a.name() === "name" && !a.required)).toBe(true);
});
