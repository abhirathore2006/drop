// Lockstep: the browser exec adapter (exec-stream.ts) mirrors the server's drop-internal exec framing
// (../../../src/ws/exec-protocol.ts) BYTE-FOR-BYTE — same pattern as validateName.test.ts. The console
// can't import the Buffer-based module at runtime, so the mirror is pinned here against the REAL one:
// down-frames the server encodes must decode correctly in the browser, and up-frames the browser encodes
// must be accepted by the server's real parsers. Node-side test; no happy-dom needed.
import { describe, expect, test } from "bun:test";
import { EXEC_STREAM as SRV, encodeExecChunk, encodeResize as srvEncodeResize, parseResize } from "../../../src/ws/exec-protocol.ts";
import { EXEC_STREAM, decodeServerFrame, encodeResizeFrame, encodeStdin, toBytes } from "./exec-stream.ts";

const u8 = (b: Buffer) => new Uint8Array(b); // the browser sees a WS binary frame as bytes, not a Buffer

describe("exec-stream ↔ exec-protocol lockstep", () => {
  test("the stream markers match the server's", () => {
    expect(EXEC_STREAM.stdout).toBe(SRV.stdout);
    expect(EXEC_STREAM.stderr).toBe(SRV.stderr);
    expect(EXEC_STREAM.exit).toBe(SRV.exit);
  });

  // Table: for each server-encoded down-frame, the browser decoder recovers the right kind + payload.
  const DOWN: Array<{ name: string; marker: number; text: string }> = [
    { name: "stdout text", marker: SRV.stdout, text: "hello world\n" },
    { name: "stderr text", marker: SRV.stderr, text: "oops: boom" },
    { name: "empty stdout", marker: SRV.stdout, text: "" },
  ];
  for (const c of DOWN) {
    test(`down-frame decodes: ${c.name}`, () => {
      const frame = decodeServerFrame(u8(encodeExecChunk(c.marker, Buffer.from(c.text))));
      expect(frame.kind).toBe(c.marker === SRV.stdout ? "stdout" : "stderr");
      if (frame.kind === "stdout" || frame.kind === "stderr") {
        expect(new TextDecoder().decode(frame.data)).toBe(c.text);
      }
    });
  }

  test("exit frame decodes to the numeric exit code the server encoded (137)", () => {
    const frame = decodeServerFrame(u8(encodeExecChunk(SRV.exit, Buffer.from("137"))));
    expect(frame).toEqual({ kind: "exit", code: 137 });
  });

  test("exit 0 decodes to 0", () => {
    const frame = decodeServerFrame(u8(encodeExecChunk(SRV.exit, Buffer.from("0"))));
    expect(frame).toEqual({ kind: "exit", code: 0 });
  });

  test("an empty frame is ignorable (marker byte absent) — mirrors decodeExecChunk's -1", () => {
    expect(decodeServerFrame(new Uint8Array(0))).toEqual({ kind: "ignore" });
  });

  test("binary payloads (ESC sequences / high bytes) survive the down decode intact", () => {
    const bin = Buffer.from([0x1b, 0x5b, 0x41, 0x00, 0xff, 0x9a]);
    const frame = decodeServerFrame(u8(encodeExecChunk(SRV.stdout, bin)));
    if (frame.kind !== "stdout") throw new Error("expected stdout");
    expect([...frame.data]).toEqual([...bin]);
  });

  test("a resize the browser encodes is accepted verbatim by the server's parseResize", () => {
    expect(encodeResizeFrame(120, 40)).toBe(srvEncodeResize(120, 40));
    expect(parseResize(encodeResizeFrame(120, 40))).toEqual({ cols: 120, rows: 40 });
  });

  test("stdin bytes match a Buffer.from of the same keystrokes (raw, no marker)", () => {
    expect([...encodeStdin("ls -la\r")]).toEqual([...Buffer.from("ls -la\r")]);
  });
});

describe("toBytes: normalize a browser WebSocket payload", () => {
  test("ArrayBuffer → Uint8Array", () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    expect([...toBytes(buf)]).toEqual([1, 2, 3]);
  });
  test("a typed-array view is honored (offset + length)", () => {
    const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);
    expect([...toBytes(view)]).toEqual([8, 7]);
  });
  test("a stray string (never sent down) → empty", () => {
    expect(toBytes("nope").length).toBe(0);
  });
});
