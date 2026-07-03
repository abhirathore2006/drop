import { test, expect } from "bun:test";
import { extractSni } from "./sni.ts";

// ---- ClientHello synthesizers ----------------------------------------------------------

/** Build a server_name extension body: server_name_list of one host_name entry. */
function serverNameExt(host: string): Buffer {
  const name = Buffer.from(host, "utf8");
  const entry = Buffer.concat([Buffer.from([0x00]), u16(name.length), name]); // name_type=host + len + name
  return Buffer.concat([u16(entry.length), entry]); // server_name_list_len + entry
}

/** Wrap an extension body with its type + length. */
function ext(type: number, body: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(body.length), body]);
}

/** Build a full TLS-record-framed ClientHello. `sni` null → no server_name extension.
 *  `extras` appends further extensions (to exercise the extension walk past server_name). */
function clientHello(sni: string | null, extras: Buffer = Buffer.alloc(0)): Buffer {
  const exts: Buffer[] = [];
  if (sni !== null) exts.push(ext(0x0000, serverNameExt(sni)));
  exts.push(extras);
  const extsBuf = Buffer.concat(exts);

  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version TLS 1.2
    Buffer.alloc(32, 7), // random
    Buffer.from([0x00]), // session_id length 0
    u16(2),
    Buffer.from([0x00, 0x2f]), // cipher_suites: one suite
    Buffer.from([0x01, 0x00]), // compression: one method (null)
    extsBuf.length ? Buffer.concat([u16(extsBuf.length), extsBuf]) : Buffer.alloc(0),
  ]);

  const hs = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]); // handshake: ClientHello
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]); // TLS record
}

/** ClientHello with NO extensions block at all (a bare TLS 1.2 hello). */
function clientHelloNoExtensions(): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 7),
    Buffer.from([0x00]),
    u16(2),
    Buffer.from([0x00, 0x2f]),
    Buffer.from([0x01, 0x00]),
    // no extensions_length field
  ]);
  const hs = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function u24(n: number): Buffer {
  return Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

// ---- table tests -----------------------------------------------------------------------

test("valid ClientHello → extracts the SNI and reports the consumed record", () => {
  const ch = clientHello("app.drop.example.com");
  const r = extractSni(ch);
  expect(r.status).toBe("done");
  if (r.status !== "done") return;
  expect(r.sni).toBe("app.drop.example.com");
  // The whole record is replayed verbatim.
  expect(r.consumed.equals(ch)).toBe(true);
});

test("SNI extraction walks PAST other extensions to find server_name", () => {
  // Put two dummy extensions before + after server_name in the source order.
  const before = Buffer.concat([
    Buffer.from([0x00, 0x0b, 0x00, 0x02, 0x01, 0x00]), // ec_point_formats (11)
  ]);
  // clientHello puts server_name first; append extras after it.
  const ch = clientHello("db.drop.example.com", before);
  const r = extractSni(ch);
  expect(r.status === "done" && r.sni).toBe("db.drop.example.com");
});

test("ClientHello with no server_name extension → done with sni null", () => {
  const ch = clientHello(null, Buffer.from([0x00, 0x0b, 0x00, 0x02, 0x01, 0x00]));
  const r = extractSni(ch);
  expect(r.status).toBe("done");
  expect(r.status === "done" && r.sni).toBe(null);
});

test("ClientHello with no extensions block at all → done with sni null", () => {
  const r = extractSni(clientHelloNoExtensions());
  expect(r.status).toBe("done");
  expect(r.status === "done" && r.sni).toBe(null);
});

test("split across TCP segments mid-record-header → incomplete until the header is whole", () => {
  const ch = clientHello("split.drop.example.com");
  // Only 3 of the 5 record-header bytes.
  expect(extractSni(ch.subarray(0, 3)).status).toBe("incomplete");
  // Full header but not the body.
  expect(extractSni(ch.subarray(0, 5)).status).toBe("incomplete");
  // Everything.
  const r = extractSni(ch);
  expect(r.status === "done" && r.sni).toBe("split.drop.example.com");
});

test("split mid-extension (one byte short) → incomplete, then done on the last byte", () => {
  const ch = clientHello("chunky.drop.example.com");
  for (let cut = 6; cut < ch.length; cut += 7) {
    expect(extractSni(ch.subarray(0, cut)).status).toBe("incomplete");
  }
  const r = extractSni(ch);
  expect(r.status === "done" && r.sni).toBe("chunky.drop.example.com");
});

test("incremental accumulation: feeding one byte at a time yields exactly one 'done'", () => {
  const ch = clientHello("byte.drop.example.com");
  let acc = Buffer.alloc(0);
  let done: string | null | undefined;
  for (const b of ch) {
    acc = Buffer.concat([acc, Buffer.from([b])]);
    const r = extractSni(acc);
    if (r.status === "done") {
      done = r.sni;
      break;
    }
    expect(r.status).toBe("incomplete");
  }
  expect(done).toBe("byte.drop.example.com");
});

test("non-TLS junk (wrong content type) → error", () => {
  const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
  const r = extractSni(junk);
  expect(r.status).toBe("error");
});

test("HTTP request bytes on the TLS port → error (content type 'G')", () => {
  const r = extractSni(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
  expect(r.status).toBe("error");
});

test("oversized record length in the header → error, no unbounded accumulation", () => {
  // Claim a 40 KB record — over the 16 KB cap → immediate error.
  const hdr = Buffer.from([0x16, 0x03, 0x01, 0xa0, 0x00]);
  const r = extractSni(hdr);
  expect(r.status).toBe("error");
});

test("malformed handshake (lying inner length) inside a complete record → error", () => {
  const ch = clientHello("bad.drop.example.com");
  // Corrupt the handshake length (bytes 6..8) to claim far more than the record holds.
  const corrupt = Buffer.from(ch);
  corrupt[6] = 0xff;
  corrupt[7] = 0xff;
  const r = extractSni(corrupt);
  expect(r.status).toBe("error");
});

test("handshake message that is not a ClientHello (type 2) → error", () => {
  const ch = clientHello("x.drop.example.com");
  const corrupt = Buffer.from(ch);
  corrupt[5] = 0x02; // ServerHello
  expect(extractSni(corrupt).status).toBe("error");
});
