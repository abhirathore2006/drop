// M5 a11y guard: the design tokens must clear WCAG AA in BOTH themes. This reads the REAL
// tokens.css (not a copy) so a future token edit that dips below 4.5:1 fails CI here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contrastRatio, parseHex } from "./contrast.ts";

const css = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

/** Extract the `--name: #hex` map for one `:root[data-theme="…"]` block. */
function themeTokens(theme: "dark" | "light"): Record<string, string> {
  const re = new RegExp(`data-theme="${theme}"\\]\\s*{([\\s\\S]*?)\\n}`, "m");
  const m = css.match(re);
  if (!m) throw new Error(`theme block not found: ${theme}`);
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const mm = line.match(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/);
    if (mm) out[mm[1]!] = mm[2]!;
  }
  return out;
}

// [foreground token, background token] — normal text, so AA is 4.5:1.
const TEXT_PAIRS: [string, string][] = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surface-raised"],
  ["text", "surface-inset"],
  ["text-muted", "bg"],
  ["text-muted", "surface"],
  ["text-muted", "surface-raised"],
  ["text-faint", "bg"],
  ["text-faint", "surface"],
  ["text-faint", "surface-raised"],
  ["on-accent", "accent"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["ok-fg", "ok-bg"],
  ["danger-fg", "danger-bg"],
  ["idle-fg", "idle-bg"],
  ["info-fg", "info-bg"],
  ["purple-fg", "purple-bg"],
  ["warn-fg", "warn-bg"],
  ["ok-fg", "bg"],
  ["danger-fg", "bg"],
  ["info-fg", "bg"],
  ["logs-fg", "surface-inset"],
  ["org-fg", "org-bg"],
  ["reveal-fg", "reveal-bg"],
];

const AA_TEXT = 4.5;

describe("contrastRatio helper", () => {
  test("black on white is ~21, identical is 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 0);
  });
  test("rejects a non-hex color", () => {
    expect(() => parseHex("rgb(0,0,0)")).toThrow();
  });
});

for (const theme of ["dark", "light"] as const) {
  describe(`design tokens clear WCAG AA (${theme})`, () => {
    const v = themeTokens(theme);
    for (const [fg, bg] of TEXT_PAIRS) {
      test(`${fg} on ${bg} ≥ ${AA_TEXT}:1`, () => {
        expect(v[fg], `missing --${fg}`).toBeDefined();
        expect(v[bg], `missing --${bg}`).toBeDefined();
        const r = contrastRatio(v[fg]!, v[bg]!);
        // Include the measured ratio in the message so a regression reads clearly.
        expect(r, `${fg}(${v[fg]}) on ${bg}(${v[bg]}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  });
}
