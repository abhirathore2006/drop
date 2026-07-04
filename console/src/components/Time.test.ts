// (M4) The relative-time math behind <Time>. Pure — `now` is injected so no clock/DOM is needed.
import { describe, expect, test } from "bun:test";
import { relativeTime } from "./Time.tsx";

const NOW = Date.parse("2026-07-04T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();

describe("relativeTime", () => {
  test("null/empty/invalid → em dash", () => {
    expect(relativeTime(null, NOW)).toBe("—");
    expect(relativeTime(undefined, NOW)).toBe("—");
    expect(relativeTime("not-a-date", NOW)).toBe("—");
  });
  test("within 5s reads 'just now'", () => {
    expect(relativeTime(ago(2_000), NOW)).toBe("just now");
  });
  test("seconds / minutes / hours / days scale", () => {
    expect(relativeTime(ago(30_000), NOW)).toBe("30s ago");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe("2d ago");
  });
  test("months and years", () => {
    expect(relativeTime(ago(60 * 86_400_000), NOW)).toBe("2mo ago");
    expect(relativeTime(ago(400 * 86_400_000), NOW)).toBe("1y ago");
  });
  test("future stamps read 'in …'", () => {
    expect(relativeTime(ahead(10 * 60_000), NOW)).toBe("in 10m");
  });
});
