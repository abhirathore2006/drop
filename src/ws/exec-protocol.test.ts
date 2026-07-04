import { test, expect } from "bun:test";
import { EXEC_STREAM, encodeExecChunk, decodeExecChunk, encodeResize, parseResize } from "./exec-protocol.ts";

// ---- the drop-internal CLI↔API exec framing (J3) — pure round-trips ----------------------------

test("encode/decode: a stdout chunk round-trips through its 1-byte marker", () => {
  const data = Buffer.from("hello world");
  const framed = encodeExecChunk(EXEC_STREAM.stdout, data);
  expect(framed[0]).toBe(EXEC_STREAM.stdout);
  const { marker, data: back } = decodeExecChunk(framed);
  expect(marker).toBe(EXEC_STREAM.stdout);
  expect(back.equals(data)).toBe(true);
});

test("decode: stdout vs stderr vs exit split on the marker byte", () => {
  expect(decodeExecChunk(encodeExecChunk(EXEC_STREAM.stdout, Buffer.from("o"))).marker).toBe(1);
  expect(decodeExecChunk(encodeExecChunk(EXEC_STREAM.stderr, Buffer.from("e"))).marker).toBe(2);
  const exit = decodeExecChunk(encodeExecChunk(EXEC_STREAM.exit, Buffer.from("137")));
  expect(exit.marker).toBe(3);
  expect(exit.data.toString()).toBe("137");
});

test("decode: an empty frame yields marker -1 (ignored, never throws)", () => {
  const { marker, data } = decodeExecChunk(Buffer.alloc(0));
  expect(marker).toBe(-1);
  expect(data.length).toBe(0);
});

test("decode preserves binary payloads (no utf-8 mangling)", () => {
  const bin = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x41, 0x9a]); // includes an ESC sequence + high bytes
  const { data } = decodeExecChunk(encodeExecChunk(EXEC_STREAM.stdout, bin));
  expect(data.equals(bin)).toBe(true);
});

test("resize: encode → parse round-trips {cols,rows}", () => {
  const s = encodeResize(120, 40);
  expect(parseResize(s)).toEqual({ cols: 120, rows: 40 });
});

test("parseResize: rejects garbage / non-positive / missing fields (→ null)", () => {
  expect(parseResize("not json")).toBeNull();
  expect(parseResize(JSON.stringify({ cols: 0, rows: 40 }))).toBeNull();
  expect(parseResize(JSON.stringify({ cols: 80 }))).toBeNull();
  expect(parseResize(JSON.stringify({ cols: "80", rows: "24" }))).toBeNull();
  expect(parseResize(JSON.stringify({ cols: 80.7, rows: 24.9 }))).toEqual({ cols: 80, rows: 24 }); // floored
});
