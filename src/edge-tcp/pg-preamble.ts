/** Pure state machine for the libpq SSL/GSS negotiation preamble on a shared Postgres port.
 *
 *  A libpq client opens a Postgres connection by first sending an 8-byte cleartext probe —
 *  either an SSLRequest or (if GSS is preferred) a GSSENCRequest — and waiting for a single
 *  byte reply before it does anything else. The L4 router uses this to get a routing key:
 *
 *    1. client → router:  SSLRequest (8 bytes)
 *    2. router → client:  'S'                  ← the router answers ITSELF, so the client will
 *                                                 send its TLS ClientHello (which carries SNI)
 *    3. client → router:  ClientHello (TLS)      ← peeked by `sni.ts`, resolves the upstream
 *    4. router → upstream: SSLRequest (8 bytes)  ← the ORIGINAL probe, replayed verbatim
 *    5. upstream → router: 'S'                   ← read + DISCARDED (the client already got its 'S')
 *    6. router → upstream: ClientHello + splice  ← TLS now completes end-to-end, router blind
 *
 *  The single 'S' byte is identical whether the router or the upstream sends it, so both sides
 *  see a well-formed Postgres-over-TLS handshake while the TLS itself stays end-to-end.
 *
 *  GSSENCRequest is answered 'N' (the router doesn't offer GSS transport encryption); libpq
 *  then falls back to an SSLRequest, which re-enters the happy path. A cleartext StartupMessage
 *  (sslmode=disable), a CancelRequest, or junk has NO routing key on a shared port → reject.
 *
 *  This module is pure: it decides transitions from buffered bytes; `server.ts` does the I/O. */

/** Every Postgres request-code message is framed as: Int32 length (== 8) then Int32 code. */
export const PREAMBLE_LEN = 8;
/** SSLRequest code (0x04D2162F) — "negotiate TLS before the startup packet". */
export const SSL_REQUEST_CODE = 80877103;
/** GSSENCRequest code (0x04D21630) — "negotiate GSSAPI encryption". Unsupported → 'N'. */
export const GSSENC_REQUEST_CODE = 80877104;

/** Single-byte replies the router writes to the client at the PG protocol layer. */
export const REPLY_WILLING = Buffer.from("S"); // 0x53 — "yes, proceed with TLS"
export const REPLY_UNWILLING = Buffer.from("N"); // 0x4E — "no" (used for the GSS probe)

export type PreambleDecision =
  /** Fewer than 8 bytes buffered — read more. */
  | { kind: "incomplete" }
  /** A valid SSLRequest: write `reply` ('S') to the client, then peek the ClientHello. Replay
   *  `sslRequest` to the upstream once resolved; `rest` is any bytes already past the probe. */
  | { kind: "ssl"; reply: Buffer; sslRequest: Buffer; rest: Buffer }
  /** A GSSENCRequest: write `reply` ('N') to the client and keep reading a probe from `rest`
   *  (libpq will follow with an SSLRequest). */
  | { kind: "gss-retry"; reply: Buffer; rest: Buffer }
  /** Not an SSL/GSS request (cleartext startup, cancel, or junk) → close, no routing key. */
  | { kind: "reject"; reason: string };

/** The preamble negotiator. The only state is whether GSS was already answered — a second GSS
 *  probe (or anything non-SSL after 'N') is rejected, so a client can't loop the router. */
export class PgPreamble {
  private gssAnswered = false;

  /** Decide the next step from the accumulated buffer. Pure — no mutation of `buf`, no I/O. */
  decide(buf: Buffer): PreambleDecision {
    if (buf.length < PREAMBLE_LEN) return { kind: "incomplete" };
    const len = buf.readUInt32BE(0);
    const code = buf.readUInt32BE(4);
    if (len !== PREAMBLE_LEN) return { kind: "reject", reason: `bad preamble length ${len}` };

    const probe = Buffer.from(buf.subarray(0, PREAMBLE_LEN)); // copied — replayed after buf churns
    const rest = buf.subarray(PREAMBLE_LEN);

    if (code === SSL_REQUEST_CODE) {
      return { kind: "ssl", reply: REPLY_WILLING, sslRequest: probe, rest };
    }
    if (code === GSSENC_REQUEST_CODE) {
      if (this.gssAnswered) return { kind: "reject", reason: "repeated GSSENCRequest" };
      this.gssAnswered = true;
      return { kind: "gss-retry", reply: REPLY_UNWILLING, rest };
    }
    // A cleartext StartupMessage (protocol 3.0 → code 0x00030000), CancelRequest (80877102),
    // or anything else: no SNI, no routing key on a shared port. sslmode=require is the fix.
    return { kind: "reject", reason: `unsupported startup code ${code}` };
  }
}
