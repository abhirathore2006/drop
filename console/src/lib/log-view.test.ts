// Pure unit tests for the live-logs helpers (log-view.ts): stream→line assembly across chunk
// boundaries, the case-insensitive grep, fixed-height virtualization windowing, and the download dump.
// Node-side; no happy-dom needed.
import { describe, expect, test } from "bun:test";
import { computeWindow, dumpLines, grepLines, LOG_BUFFER_CAP, type LogLine, splitStreamChunk, VIRTUALIZE_THRESHOLD } from "./log-view.ts";

const mk = (texts: string[], from = 0): LogLine[] => texts.map((text, i) => ({ id: from + i, text }));

describe("splitStreamChunk", () => {
  test("splits complete lines and carries the partial trailing line", () => {
    const r = splitStreamChunk("", "one\ntwo\nthr");
    expect(r.lines).toEqual(["one", "two"]);
    expect(r.carry).toBe("thr");
  });

  test("a carry from the previous chunk prepends to the next", () => {
    const a = splitStreamChunk("", "hel");
    expect(a.lines).toEqual([]);
    expect(a.carry).toBe("hel");
    const b = splitStreamChunk(a.carry, "lo world\nnext");
    expect(b.lines).toEqual(["hello world"]);
    expect(b.carry).toBe("next");
  });

  test("a chunk that ends exactly on a newline leaves an empty carry", () => {
    const r = splitStreamChunk("", "a\nb\n");
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.carry).toBe("");
  });
});

describe("grepLines", () => {
  const lines = mk(["INFO started", "WARN slow query", "ERROR boom", "info again"]);
  test("a blank query passes everything (same reference of contents)", () => {
    expect(grepLines(lines, "")).toBe(lines);
    expect(grepLines(lines, "   ")).toBe(lines);
  });
  test("case-insensitive substring match, order + ids preserved", () => {
    const r = grepLines(lines, "info");
    expect(r.map((l) => l.text)).toEqual(["INFO started", "info again"]);
    expect(r.map((l) => l.id)).toEqual([0, 3]);
  });
  test("no match → empty", () => {
    expect(grepLines(lines, "zzz")).toEqual([]);
  });
});

describe("computeWindow", () => {
  test("below the virtualize threshold → the whole range, no spacers", () => {
    const w = computeWindow(VIRTUALIZE_THRESHOLD, 0, 360, 18);
    expect(w).toEqual({ start: 0, end: VIRTUALIZE_THRESHOLD, padTop: 0, padBottom: 0 });
  });

  test("above the threshold → a clamped window whose spacers + rows cover the full height", () => {
    const total = 2000;
    const lineH = 18;
    const viewportH = 360;
    const w = computeWindow(total, 9000, viewportH, lineH, 12);
    expect(w.start).toBeGreaterThan(0);
    expect(w.end).toBeLessThanOrEqual(total);
    expect(w.end).toBeGreaterThan(w.start);
    // padTop + rendered rows + padBottom must equal the full virtual height (no scrollbar drift).
    const rendered = (w.end - w.start) * lineH;
    expect(w.padTop + rendered + w.padBottom).toBe(total * lineH);
    // the window brackets the scroll offset (500th row) with overscan.
    expect(w.start).toBeLessThanOrEqual(500);
    expect(w.end).toBeGreaterThanOrEqual(500);
  });

  test("a degenerate measurement (zero line height) falls back to the full range", () => {
    const w = computeWindow(2000, 100, 360, 0);
    expect(w).toEqual({ start: 0, end: 2000, padTop: 0, padBottom: 0 });
  });

  test("the tail window (scrolled to bottom) ends exactly at total", () => {
    const total = 1000;
    const lineH = 18;
    const viewportH = 360;
    const w = computeWindow(total, total * lineH - viewportH, viewportH, lineH);
    expect(w.end).toBe(total);
    expect(w.padBottom).toBe(0);
  });
});

describe("dumpLines", () => {
  test("joins with newlines and a trailing newline when non-empty", () => {
    expect(dumpLines(mk(["a", "b", "c"]))).toBe("a\nb\nc\n");
  });
  test("empty buffer → empty string", () => {
    expect(dumpLines([])).toBe("");
  });
});

describe("constants", () => {
  test("the buffer cap sits above the virtualize threshold (virtualization actually engages)", () => {
    expect(LOG_BUFFER_CAP).toBeGreaterThan(VIRTUALIZE_THRESHOLD);
  });
});
