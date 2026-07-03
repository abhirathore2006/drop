import { test, expect } from "bun:test";
import { PgPreamble, SSL_REQUEST_CODE, GSSENC_REQUEST_CODE, PREAMBLE_LEN } from "./pg-preamble.ts";

/** Build an 8-byte Postgres request-code message: Int32 length + Int32 code. */
function probe(code: number, len = PREAMBLE_LEN): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(len, 0);
  b.writeUInt32BE(code, 4);
  return b;
}

const sslRequest = () => probe(SSL_REQUEST_CODE);
const gssRequest = () => probe(GSSENC_REQUEST_CODE);
const cancelRequest = () => probe(80877102); // CancelRequest
const startup30 = () => probe(0x00030000); // cleartext StartupMessage protocol 3.0

test("fewer than 8 bytes → incomplete", () => {
  expect(new PgPreamble().decide(Buffer.alloc(0)).kind).toBe("incomplete");
  expect(new PgPreamble().decide(sslRequest().subarray(0, 7)).kind).toBe("incomplete");
});

test("valid SSLRequest → 'ssl': reply 'S', replay the ORIGINAL 8 bytes upstream", () => {
  const d = new PgPreamble().decide(sslRequest());
  expect(d.kind).toBe("ssl");
  if (d.kind !== "ssl") return;
  expect(d.reply.toString()).toBe("S");
  expect(d.sslRequest.equals(sslRequest())).toBe(true);
  expect(d.rest.length).toBe(0);
});

test("SSLRequest carrying leftover bytes → 'rest' holds them (start of the ClientHello)", () => {
  const trailer = Buffer.from([0x16, 0x03, 0x01]);
  const d = new PgPreamble().decide(Buffer.concat([sslRequest(), trailer]));
  expect(d.kind === "ssl" && d.rest.equals(trailer)).toBe(true);
});

test("GSSENCRequest → 'gss-retry': reply 'N', then a following SSLRequest is accepted", () => {
  const pg = new PgPreamble();
  const first = pg.decide(gssRequest());
  expect(first.kind).toBe("gss-retry");
  if (first.kind !== "gss-retry") return;
  expect(first.reply.toString()).toBe("N");
  // libpq follows the 'N' with an SSLRequest — the SAME state machine now accepts it.
  const second = pg.decide(sslRequest());
  expect(second.kind).toBe("ssl");
});

test("repeated GSSENCRequest (GSS twice) → reject (can't loop the router)", () => {
  const pg = new PgPreamble();
  expect(pg.decide(gssRequest()).kind).toBe("gss-retry");
  expect(pg.decide(gssRequest()).kind).toBe("reject");
});

test("GSS then a cleartext startup → reject (no routing key)", () => {
  const pg = new PgPreamble();
  expect(pg.decide(gssRequest()).kind).toBe("gss-retry");
  expect(pg.decide(startup30()).kind).toBe("reject");
});

test("cleartext StartupMessage (sslmode=disable) → reject", () => {
  expect(new PgPreamble().decide(startup30()).kind).toBe("reject");
});

test("CancelRequest → reject (not a routable connection)", () => {
  expect(new PgPreamble().decide(cancelRequest()).kind).toBe("reject");
});

test("wrong length prefix (len != 8) → reject", () => {
  expect(new PgPreamble().decide(probe(SSL_REQUEST_CODE, 12)).kind).toBe("reject");
});

test("random junk → reject", () => {
  expect(new PgPreamble().decide(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])).kind).toBe("reject");
});
