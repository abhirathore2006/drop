/** Pure, incremental TLS ClientHello SNI extractor. The L4 router PEEKS the SNI to pick an
 *  upstream but NEVER terminates TLS — the exact bytes fed in are replayed to the upstream
 *  verbatim, so the handshake (and everything after) stays end-to-end encrypted. The router
 *  only ever reads the one cleartext field it needs: the `server_name` extension.
 *
 *  Feed the accumulated buffer as more TCP segments arrive; `extractSni` returns:
 *    - `incomplete` — a full ClientHello record isn't buffered yet (keep accumulating),
 *    - `done`       — parsed; `sni` is the host_name (or null if there's no SNI extension),
 *                     `consumed` is the ClientHello record bytes to replay upstream,
 *    - `error`      — not a TLS handshake / malformed / oversized (the caller closes).
 *
 *  Only the common single-record ClientHello is supported (a ClientHello is < 16 KB, which is
 *  a single TLS record); a fragmented or oversized handshake is an `error`. */

/** A TLS record + ClientHello can't exceed one 16 KB record; past this we stop accumulating
 *  and fail rather than let a peer pin memory with a never-completing "handshake". */
export const MAX_CLIENT_HELLO = 16 * 1024;

const TLS_HANDSHAKE = 0x16; // TLS record content type 22
const CLIENT_HELLO = 0x01; // handshake message type 1
const EXT_SERVER_NAME = 0x0000; // extension type: server_name (SNI)
const NAME_TYPE_HOST = 0x00; // server_name_list entry: host_name

export type SniResult =
  | { status: "incomplete" }
  | { status: "done"; sni: string | null; consumed: Buffer }
  | { status: "error"; reason: string };

/** Try to extract the SNI from a (possibly partial) buffer of ClientHello bytes. Pure: no
 *  socket, no mutation of `buf`. Any out-of-range read inside a fully-present record is a
 *  malformed-handshake `error` (the length prefixes lied); short buffers are `incomplete`. */
export function extractSni(buf: Buffer): SniResult {
  // --- TLS record header (5 bytes): type(1) version(2) length(2) ---
  if (buf.length < 5) return { status: "incomplete" };
  if (buf[0] !== TLS_HANDSHAKE) return { status: "error", reason: "not a TLS handshake record" };
  if (buf[1] !== 0x03) return { status: "error", reason: "unsupported TLS record version" };
  const recordLen = buf.readUInt16BE(3);
  if (recordLen === 0) return { status: "error", reason: "empty TLS record" };
  if (recordLen > MAX_CLIENT_HELLO) return { status: "error", reason: "ClientHello record too large" };
  const recordEnd = 5 + recordLen;
  if (buf.length < recordEnd) {
    // Not all the record bytes are here yet — but bound the wait so a lying length can't
    // make us accumulate forever (recordLen is already capped, so this only trips on junk).
    if (buf.length > MAX_CLIENT_HELLO) return { status: "error", reason: "ClientHello too large" };
    return { status: "incomplete" };
  }

  try {
    const sni = parseClientHello(buf.subarray(5, recordEnd));
    return { status: "done", sni, consumed: buf.subarray(0, recordEnd) };
  } catch {
    // Any bounds violation inside a complete record ⇒ the handshake is malformed.
    return { status: "error", reason: "malformed ClientHello" };
  }
}

/** Parse the handshake message inside one complete TLS record. Returns the host_name, or null
 *  when the ClientHello has no server_name extension. Throws (a RangeError) on any malformed
 *  length prefix — `extractSni` turns that into an `error`. */
function parseClientHello(rec: Buffer): string | null {
  // --- handshake header: type(1) length(3) ---
  if (rec[0] !== CLIENT_HELLO) throw new Error("not a ClientHello");
  const hsLen = (rec[1]! << 16) | (rec[2]! << 8) | rec[3]!;
  const body = rec.subarray(4, 4 + hsLen);
  if (body.length < hsLen) throw new Error("fragmented ClientHello");

  // --- ClientHello body ---
  let p = 0;
  p += 2; // client_version
  p += 32; // random
  const sidLen = readU8(body, p);
  p += 1 + sidLen; // session_id
  const csLen = readU16(body, p);
  p += 2 + csLen; // cipher_suites
  const cmLen = readU8(body, p);
  p += 1 + cmLen; // compression_methods

  // Extensions are optional (a bare TLS 1.2 ClientHello may omit them entirely).
  if (p >= body.length) return null;
  const extTotal = readU16(body, p);
  p += 2;
  const extEnd = p + extTotal;
  if (extEnd > body.length) throw new Error("extensions overrun");

  while (p + 4 <= extEnd) {
    const extType = readU16(body, p);
    const extLen = readU16(body, p + 2);
    p += 4;
    if (p + extLen > extEnd) throw new Error("extension overrun");
    if (extType === EXT_SERVER_NAME) return parseServerName(body.subarray(p, p + extLen));
    p += extLen;
  }
  return null; // no server_name extension present
}

/** Parse a server_name extension body → the first host_name entry, or null. */
function parseServerName(ext: Buffer): string | null {
  const listLen = readU16(ext, 0);
  const listEnd = 2 + listLen;
  if (listEnd > ext.length) throw new Error("server_name_list overrun");
  let p = 2;
  while (p + 3 <= listEnd) {
    const nameType = readU8(ext, p);
    const nameLen = readU16(ext, p + 1);
    p += 3;
    if (p + nameLen > listEnd) throw new Error("host_name overrun");
    if (nameType === NAME_TYPE_HOST) return ext.subarray(p, p + nameLen).toString("utf8");
    p += nameLen;
  }
  return null;
}

// Bounds-checked reads: `subarray` past the end yields a short buffer whose read* throws a
// RangeError, which parseClientHello turns into a malformed-handshake error.
function readU8(b: Buffer, off: number): number {
  return b.readUInt8(off);
}
function readU16(b: Buffer, off: number): number {
  return b.readUInt16BE(off);
}
