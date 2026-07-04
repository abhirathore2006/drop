import { test, expect } from "bun:test";
import { FrameDecoder, encodeFrame, encodeClose, acceptKey, newSecWebSocketKey, OPCODE } from "./frames.ts";

/** Round-trip a payload through encode → decode and return the single decoded frame. */
function roundTrip(payload: Buffer, opts: { opcode?: number; masked?: boolean } = {}) {
  const frame = encodeFrame(payload, opts);
  const [f, ...extra] = new FrameDecoder().push(frame);
  expect(extra).toHaveLength(0);
  return f!;
}

test("acceptKey matches the RFC 6455 example", () => {
  // The canonical example from RFC 6455 §1.3.
  expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("newSecWebSocketKey is 16 random bytes, base64", () => {
  const k = newSecWebSocketKey();
  expect(Buffer.from(k, "base64")).toHaveLength(16);
  expect(newSecWebSocketKey()).not.toBe(k);
});

test("round-trips binary payloads unmasked (server→client) and masked (client→server)", () => {
  const payload = Buffer.from("select 1;");
  for (const masked of [false, true]) {
    const f = roundTrip(payload, { opcode: OPCODE.binary, masked });
    expect(f.opcode).toBe(OPCODE.binary);
    expect(f.fin).toBe(true);
    expect(f.payload.equals(payload)).toBe(true);
  }
});

test("a masked frame is not cleartext on the wire but decodes back to the payload", () => {
  const payload = Buffer.from("PGPASSWORD-ish-secret-bytes");
  const framed = encodeFrame(payload, { opcode: OPCODE.binary, masked: true });
  // masked body must differ from the raw payload (the XOR mask actually applied)
  expect(framed.subarray(-payload.length).equals(payload)).toBe(false);
  const [f] = new FrameDecoder().push(framed);
  expect(f!.payload.equals(payload)).toBe(true);
});

test("all three length forms: 7-bit, 16-bit, 64-bit", () => {
  for (const len of [0, 1, 125, 126, 65535, 65536, 200000]) {
    const payload = Buffer.alloc(len, 0xab);
    const f = roundTrip(payload, { masked: len % 2 === 0 }); // vary masking too
    expect(f.payload.length).toBe(len);
    expect(f.payload.equals(payload)).toBe(true);
  }
});

test("streaming: a frame split across chunks decodes once the last byte arrives; leftover is retained", () => {
  const dec = new FrameDecoder();
  const frame = encodeFrame(Buffer.from("hello world"), { masked: true });
  // feed it one byte at a time — no frame emitted until the final byte
  for (let i = 0; i < frame.length - 1; i++) expect(dec.push(frame.subarray(i, i + 1))).toHaveLength(0);
  const out = dec.push(frame.subarray(frame.length - 1));
  expect(out).toHaveLength(1);
  expect(out[0]!.payload.toString()).toBe("hello world");
});

test("multiple frames in one chunk all decode, in order", () => {
  const a = encodeFrame(Buffer.from("one"), { masked: true });
  const b = encodeFrame(Buffer.from("two"), { masked: true });
  const c = encodeFrame(Buffer.from("three"), { masked: true });
  const out = new FrameDecoder().push(Buffer.concat([a, b, c]));
  expect(out.map((f) => f.payload.toString())).toEqual(["one", "two", "three"]);
});

test("control frames decode with their opcode; encodeClose carries the status code", () => {
  const [ping] = new FrameDecoder().push(encodeFrame(Buffer.from("hi"), { opcode: OPCODE.ping, masked: true }));
  expect(ping!.opcode).toBe(OPCODE.ping);
  const [close] = new FrameDecoder().push(encodeClose(1000, false));
  expect(close!.opcode).toBe(OPCODE.close);
  expect(close!.payload.readUInt16BE(0)).toBe(1000);
});

test("a frame whose declared length exceeds the cap throws (memory-DoS bound)", () => {
  const dec = new FrameDecoder(8); // tiny cap
  // header claims a 16-bit length of 100 (> 8) → throws as soon as the length is known
  const header = Buffer.from([0x82, 126, 0x00, 0x64]);
  expect(() => dec.push(header)).toThrow(/too large/);
});
