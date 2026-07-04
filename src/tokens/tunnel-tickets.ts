// Short-lived, single-use tunnel tickets (A3, `db:proxy`). The single seam over `tunnel_tickets`.
//
// A ticket is the credential the WebSocket psql tunnel presents at UPGRADE time. It is minted by an
// authenticated `POST /v1/databases/:name/tunnel-ticket` (authz `connect`), bound to (user, database),
// and redeemed EXACTLY once by the tunnel handler. Modeled on the service-token store: the secret has
// the shape `drop_tt_<64 hex>` and is returned once at issuance; only its sha256 hash is stored, so a
// leaked metastore yields no usable ticket. Single-use is enforced atomically by a conditional UPDATE
// that flips `used_at` (no read-then-write race — two redemptions of the same ticket can't both win).
import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../db/db.ts";

/** Secret prefix — mirrors the `drop_st_` service-token prefix so the shape is recognizable. */
export const TICKET_PREFIX = "drop_tt_";
/** Default ticket TTL: 60s. Long enough for the CLI to open the tunnel, short enough to bound replay. */
const DEFAULT_TTL_MS = 60_000;

/** The outcome of a successful redemption — the identity material the tunnel handler audits. */
export interface RedeemedTicket {
  email: string; // the user the ticket was issued to (the audited `db.tunnel.open` actor)
  siteName: string; // the database the tunnel is authorized for
}

export class TunnelTicketStore {
  // `now` is injectable so tests drive TTL deterministically; `ttlMs` is configurable (env override).
  constructor(private db: Db, private now: () => Date = () => new Date(), private ttlMs: number = DEFAULT_TTL_MS) {}

  private static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** Mint a ticket bound to (siteName, email). Returns the raw secret ONCE (never recoverable) plus its
   *  expiry. The caller MUST have authorized `connect` on the database first. */
  async issue(siteName: string, email: string): Promise<{ ticket: string; expiresAt: string }> {
    const secret = TICKET_PREFIX + randomBytes(32).toString("hex"); // drop_tt_<64 hex>
    const id = "tt_" + randomBytes(12).toString("hex");
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlMs);
    await this.db
      .insertInto("tunnel_tickets")
      .values({
        id,
        token_hash: TunnelTicketStore.hash(secret),
        site_name: siteName,
        email: email.toLowerCase(),
        expires_at: expiresAt,
        used_at: null,
        created_at: issuedAt,
      })
      .execute();
    return { ticket: secret, expiresAt: expiresAt.toISOString() };
  }

  /** Redeem a ticket for `siteName`. Returns the bound identity on success, or null if the ticket is
   *  unknown / for a DIFFERENT database / expired / ALREADY used. Single-use + unexpired + right-db are
   *  all enforced in one atomic conditional UPDATE (flipping `used_at`), so a replay or a concurrent
   *  second redemption can never both succeed. */
  async redeem(token: string, siteName: string): Promise<RedeemedTicket | null> {
    if (!token.startsWith(TICKET_PREFIX)) return null;
    const now = this.now();
    const res = await this.db
      .updateTable("tunnel_tickets")
      .set({ used_at: now })
      .where("token_hash", "=", TunnelTicketStore.hash(token))
      .where("site_name", "=", siteName) // wrong-db → no match → null
      .where("used_at", "is", null) // single-use latch
      .where("expires_at", ">", now) // unexpired
      .returning(["email", "site_name"])
      .executeTakeFirst();
    return res ? { email: res.email as string, siteName: res.site_name as string } : null;
  }

  /** Delete spent / expired tickets (a housekeeping sweep can call this; rows are tiny + transient with
   *  a 60s TTL, so this is hygiene, not a hot path). Returns the number removed. */
  async deleteExpired(before: Date = this.now()): Promise<number> {
    const res = await this.db
      .deleteFrom("tunnel_tickets")
      .where((eb) => eb.or([eb("expires_at", "<=", before), eb("used_at", "is not", null)]))
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n);
  }
}
