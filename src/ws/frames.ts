// Minimal RFC 6455 WebSocket frame codec — the shared building block for the `db:proxy` tunnel (A3).
// Both ends of the tunnel need it: the API server DECODES masked client frames + ENCODES unmasked
// server frames; the CLI client ENCODES masked frames + DECODES unmasked server frames. One codec
// with a `masked` flag covers both, so the wire format lives in exactly one place (the edge WS proxy
// is a transparent byte tunnel — it never frames — so it deliberately doesn't use this).
//
// Scope kept deliberately small: single-frame messages (the tunnel never needs to reassemble a
// fragmented logical message — it treats every data frame's payload as a slice of the TCP byte
// stream), all three length forms (7-bit, 16-bit, 64-bit), masking both directions, and the control
// opcodes we must answer (close/ping/pong). No permessage-deflate, no continuation reassembly.
import { createHash, randomBytes } from "node:crypto";

/** The RFC 6455 handshake GUID — appended to the client key to compute Sec-WebSocket-Accept. */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** Sec-WebSocket-Accept for a client's Sec-WebSocket-Key (base64 of sha1(key + GUID)). */
export function acceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

/** A fresh random 16-byte Sec-WebSocket-Key (base64), for the CLIENT handshake. */
export function newSecWebSocketKey(): string {
  return randomBytes(16).toString("base64");
}

/** One decoded frame. `payload` is already unmasked. */
export interface Frame {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

/** Encode a single (FIN) frame. `masked` MUST be true for client→server frames (RFC 6455 §5.1 — a
 *  server MUST close a connection that receives an unmasked client frame) and false for
 *  server→client frames. The mask key is fresh per frame. */
export function encodeFrame(payload: Buffer, opts: { opcode?: number; masked?: boolean } = {}): Buffer {
  const opcode = opts.opcode ?? OPCODE.binary;
  const masked = opts.masked ?? false;
  const len = payload.length;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | 127;
    // 64-bit length; JS payloads never exceed 2^53, so the high word is written as 0.
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }

  if (!masked) return Buffer.concat([header, payload]);

  const mask = randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([header, mask, body]);
}

/** A close frame with an optional status code (default 1000, normal closure). */
export function encodeClose(code = 1000, masked = false): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return encodeFrame(payload, { opcode: OPCODE.close, masked });
}

/** Streaming frame decoder: feed it TCP chunks, get back every complete frame. Partial frames are
 *  buffered until the rest of their bytes arrive (a single WS frame can span multiple TCP reads, and
 *  a single TCP read can carry multiple frames). Throws on a frame whose declared length exceeds
 *  `maxFrameBytes` (a memory-DoS bound) — the caller should tear the connection down. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxFrameBytes = 16 * 1024 * 1024) {}

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    for (;;) {
      const frame = this.next();
      if (!frame) break;
      out.push(frame);
    }
    return out;
  }

  private next(): Frame | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0]! & 0x80) !== 0;
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    let len = b[1]! & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off);
      const lo = b.readUInt32BE(off + 4);
      len = hi * 0x100000000 + lo;
      off += 8;
    }
    if (len > this.maxFrameBytes) throw new Error(`ws frame too large: ${len} > ${this.maxFrameBytes}`);
    let mask: Buffer | null = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null; // full payload not buffered yet
    let payload = b.subarray(off, off + len);
    if (mask) {
      const u = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) u[i] = payload[i]! ^ mask[i & 3]!;
      payload = u;
    } else {
      payload = Buffer.from(payload); // copy off the shared buffer before we slice it away
    }
    this.buf = b.subarray(off + len);
    return { opcode, payload, fin };
  }
}
