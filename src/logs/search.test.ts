import { test, expect } from "bun:test";
import { FakeBlob } from "../blob/fake.ts";
import { makeMatcher, parseTs, searchLogObjects, type LogObjectRef } from "./search.ts";
import { serializeNdjsonGz, logObjectKey, type LogRecord } from "./format.ts";

test("makeMatcher: empty → all; substring; case-insensitive; regex", () => {
  expect(makeMatcher("")("anything")).toBe(true);
  expect(makeMatcher("err")("an error")).toBe(true);
  expect(makeMatcher("ERR")("an error")).toBe(false);
  expect(makeMatcher("ERR", { ignoreCase: true })("an error")).toBe(true);
  expect(makeMatcher("e\\d+", { regex: true })("code e42")).toBe(true);
  expect(makeMatcher("^GET", { regex: true })("POST /")).toBe(false);
  expect(() => makeMatcher("(", { regex: true })).toThrow(); // bad pattern → route surfaces a 400
});

test("parseTs: epoch seconds, epoch ms, ISO, or null", () => {
  expect(parseTs(undefined)).toBeNull();
  expect(parseTs("")).toBeNull();
  expect(parseTs("nonsense")).toBeNull();
  expect(parseTs("1751626500")).toBe(1751626500 * 1000); // seconds → ms
  expect(parseTs("1751626500000")).toBe(1751626500000); // already ms
  expect(parseTs("2026-07-04T10:15:00.000Z")).toBe(Date.parse("2026-07-04T10:15:00.000Z"));
});

// Build an in-memory blob with a few hour objects; return the newest-first refs the index would hand back.
async function seed(): Promise<{ blob: FakeBlob; objects: LogObjectRef[] }> {
  const blob = new FakeBlob();
  const rec = (ts: string, line: string): LogRecord => ({ ts, site: "web", pod: "web", stream: "stdout", line });
  const hours: { hour: string; records: LogRecord[] }[] = [
    { hour: "2026-07-04T09:00:00Z", records: [rec("2026-07-04T09:10:00Z", "GET /a 200"), rec("2026-07-04T09:20:00Z", "ERROR boom")] },
    { hour: "2026-07-04T10:00:00Z", records: [rec("2026-07-04T10:05:00Z", "GET /b 200"), rec("2026-07-04T10:30:00Z", "ERROR kaboom")] },
  ];
  for (const h of hours) {
    const key = logObjectKey("web", new Date(h.hour));
    const bytes = serializeNdjsonGz(h.records);
    await blob.put(key, bytes, bytes.byteLength, "application/gzip");
  }
  // newest-first (hour DESC), as listLogObjectsInRange returns
  return {
    blob,
    objects: [
      { hour: new Date("2026-07-04T10:00:00Z"), key: logObjectKey("web", new Date("2026-07-04T10:00:00Z")) },
      { hour: new Date("2026-07-04T09:00:00Z"), key: logObjectKey("web", new Date("2026-07-04T09:00:00Z")) },
    ],
  };
}

test("searchLogObjects: substring match, newest object first, per-line ts filter", async () => {
  const { blob, objects } = await seed();
  const res = await searchLogObjects({
    blob,
    objects,
    from: new Date("2026-07-04T00:00:00Z"),
    to: new Date("2026-07-04T23:00:00Z"),
    match: makeMatcher("ERROR"),
    limit: 100,
  });
  expect(res.lines.map((l) => l.line)).toEqual(["ERROR kaboom", "ERROR boom"]); // hour 10 (newest) before hour 09
  expect(res.scanned).toBe(2);
  expect(res.truncated).toBe(false);
});

test("searchLogObjects: time range narrows via per-record ts (excludes out-of-window lines)", async () => {
  const { blob, objects } = await seed();
  const res = await searchLogObjects({
    blob,
    objects,
    from: new Date("2026-07-04T10:00:00Z"),
    to: new Date("2026-07-04T11:00:00Z"),
    match: makeMatcher(""), // all
    limit: 100,
  });
  expect(res.lines.map((l) => l.line)).toEqual(["GET /b 200", "ERROR kaboom"]); // only the hour-10 records
});

test("searchLogObjects: regex match", async () => {
  const { blob, objects } = await seed();
  const res = await searchLogObjects({
    blob,
    objects,
    from: new Date("2026-07-04T00:00:00Z"),
    to: new Date("2026-07-04T23:00:00Z"),
    match: makeMatcher("^GET /a", { regex: true }),
    limit: 100,
  });
  expect(res.lines.map((l) => l.line)).toEqual(["GET /a 200"]);
});

test("searchLogObjects: cap + truncated flag, and stops reading once the cap is met", async () => {
  const { blob, objects } = await seed();
  const res = await searchLogObjects({
    blob,
    objects,
    from: new Date("2026-07-04T00:00:00Z"),
    to: new Date("2026-07-04T23:00:00Z"),
    match: makeMatcher(""), // all 4 lines match
    limit: 1,
  });
  expect(res.lines).toHaveLength(1);
  expect(res.truncated).toBe(true);
  expect(res.scanned).toBe(1); // never opened the older object — cap hit inside the first
});

test("searchLogObjects: a missing object (retention race) is skipped, not fatal", async () => {
  const { blob, objects } = await seed();
  const withGhost: LogObjectRef[] = [{ hour: new Date("2026-07-04T11:00:00Z"), key: "logs/web/2026-07-04T11.ndjson.gz" }, ...objects];
  const res = await searchLogObjects({
    blob,
    objects: withGhost,
    from: new Date("2026-07-04T00:00:00Z"),
    to: new Date("2026-07-04T23:00:00Z"),
    match: makeMatcher("ERROR"),
    limit: 100,
  });
  expect(res.lines.map((l) => l.line)).toEqual(["ERROR kaboom", "ERROR boom"]);
  expect(res.scanned).toBe(2); // the ghost wasn't counted
});
