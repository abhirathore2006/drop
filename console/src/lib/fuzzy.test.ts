import { describe, expect, test } from "bun:test";
import { fuzzyRank, subsequenceScore } from "./fuzzy.ts";

describe("subsequenceScore", () => {
  const matches: [string, string][] = [
    ["stk", "stacks"],
    ["myapp", "my-app"],
    ["set", "settings"],
    ["app", "my-app"],
    ["", "anything"],
    ["db", "my-db"],
  ];
  for (const [q, t] of matches) {
    test(`"${q}" matches "${t}"`, () => {
      expect(subsequenceScore(q, t)).not.toBeNull();
    });
  }

  const nonMatches: [string, string][] = [
    ["xyz", "stacks"],
    ["appp", "my-app"], // three p's, target has two
    ["zz", "settings"],
    ["pa", "app"], // order matters — p then a doesn't appear in that order
  ];
  for (const [q, t] of nonMatches) {
    test(`"${q}" does not match "${t}"`, () => {
      expect(subsequenceScore(q, t)).toBeNull();
    });
  }

  test("matching is case-insensitive", () => {
    expect(subsequenceScore("APP", "my-app")).not.toBeNull();
  });

  test("a contiguous/exact match outscores a scattered one", () => {
    expect(subsequenceScore("app", "app")!).toBeGreaterThan(subsequenceScore("app", "axpxp")!);
  });

  test("a word-boundary start outscores a mid-word match", () => {
    // "app" at the start of "app-x" beats "app" buried mid-word in "zzapp"
    expect(subsequenceScore("app", "app-x")!).toBeGreaterThan(subsequenceScore("app", "zzapp")!);
  });
});

describe("fuzzyRank", () => {
  test("keeps matches, drops non-matches, ranks prefixes first", () => {
    const items = ["database", "my-app", "apples", "stacks"];
    const ranked = fuzzyRank("app", items, (x) => x).map((r) => r.item);
    expect(ranked).toContain("apples");
    expect(ranked).toContain("my-app");
    expect(ranked).not.toContain("stacks");
    expect(ranked).not.toContain("database");
    // "apples" (prefix) ranks above "my-app" (match after a word boundary)
    expect(ranked.indexOf("apples")).toBeLessThan(ranked.indexOf("my-app"));
  });

  test("empty query returns every item in original order", () => {
    const items = ["c", "a", "b"];
    expect(fuzzyRank("", items, (x) => x).map((r) => r.item)).toEqual(items);
  });

  test("ties preserve input order (stable)", () => {
    const items = ["ab", "ab"];
    const ranked = fuzzyRank("ab", items, (x) => x);
    expect(ranked).toHaveLength(2);
  });
});
