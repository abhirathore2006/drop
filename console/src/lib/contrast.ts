// Pure WCAG 2.x contrast-ratio math (M5 a11y). No DOM, no deps — so the design tokens can be
// asserted against AA thresholds in a plain unit test (lib/contrast.test.ts) in both themes.
//
// Ratio ranges 1 (identical) … 21 (black on white). WCAG AA needs ≥ 4.5:1 for normal text,
// ≥ 3:1 for large text and meaningful UI boundaries.

/** Parse `#rgb` / `#rrggbb` (with or without leading #) into 0..255 channels. Throws on garbage
 *  so a typo'd token surfaces loudly rather than silently scoring 1:1. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a hex color: ${hex}`);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** sRGB channel (0..255) → linearized component, per the WCAG relative-luminance definition. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance (0..1) of an sRGB hex color. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two hex colors (order-independent), in [1, 21]. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** True when `fg` on `bg` clears the threshold (default AA normal-text 4.5:1). */
export function passesAA(fg: string, bg: string, min = 4.5): boolean {
  return contrastRatio(fg, bg) >= min;
}
