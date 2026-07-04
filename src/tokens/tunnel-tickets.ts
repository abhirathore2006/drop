// Short-lived, single-use tickets over the `tunnel_tickets` table. The single seam for BOTH A3's
// `db:proxy` psql tunnel and J3's `drop exec` shell bridge — one table, KINDED (migration 0015).
//
// A ticket is the credential a WebSocket upgrade presents (the upgrade runs OUTSIDE Hono's bearer
// middleware, so the ticket is what makes the raw-socket upgrade safe). It is minted by an
// authenticated, resource-authorized POST, bound to (user, resource), and redeemed EXACTLY once by
// the upgrade handler. Modeled on the service-token store: the secret has the shape `drop_tt_<64 hex>`
// and is returned once at issuance; only its sha256 hash is stored, so a leaked metastore yields no
// usable ticket. Single-use is enforced atomically by a conditional UPDATE that flips `used_at` (no
// read-then-write race — two redemptions of the same ticket can't both win).
//
// KIND + COMMAND (J3). `kind` discriminates a `tunnel` ticket (A3, no argv) from an `exec` ticket
// (J3), and redemption REQUIRES the kind to match — so an exec ticket can never be redeemed on the
// tunnel path (or vice versa). An exec ticket also stores the exact `command` argv it authorizes: the
// WS bridge runs THAT command, never one supplied at upgrade time, so a redeemed exec upgrade can't
// escalate to a different command than the one `can("exec")` was checked against at issuance.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";
import type { TicketKind } from "../db/schema.ts";

/** Secret prefix — mirrors the `drop_st_` service-token prefix so the shape is recognizable. */
export const TICKET_PREFIX = "drop_tt_";
/** Default ticket TTL: 60s. Long enough for the CLI to open the tunnel, short enough to bound replay. */
const DEFAULT_TTL_MS = 60_000;

/** The outcome of a successful redemption — the identity material the upgrade handler audits, plus
 *  (exec) the bound command the bridge must run. */
export interface RedeemedTicket {
  email: string; // the user the ticket was issued to (the audited actor)
  siteName: string; // the resource the ticket is authorized for (a database for tunnel; an app for exec)
  kind: TicketKind; // 'tunnel' | 'exec'
  command: string[] | null; // exec argv (bound at issue); null for a tunnel ticket
}

/** Options for `issue` (J3). Absent → the A3 default: a `tunnel` ticket with no command. */
export interface IssueOptions {
  kind?: TicketKind;
  command?: string[] | null; // stored as json; the WS bridge runs EXACTLY this (no escalation)
}

/** jsonb `command`: PGlite hands it back parsed, node-postgres too — but tolerate a string just in case. */
function parseCommand(v: unknown): string[] | null {
  if (v == null) return null;
  const arr = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(arr) ? (arr as string[]) : null;
}

export class TunnelTicketStore {
  // `now` is injectable so tests drive TTL deterministically; `ttlMs` is configurable (env override).
  constructor(private db: Db, private now: () => Date = () => new Date(), private ttlMs: number = DEFAULT_TTL_MS) {}

  private static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** Mint a ticket bound to (siteName, email). Returns the raw secret ONCE (never recoverable) plus its
   *  expiry. The caller MUST have authorized the relevant verb first (`connect` for a tunnel, `exec`
   *  for a shell). `opts.kind`/`opts.command` default to a plain A3 tunnel ticket. */
  async issue(siteName: string, email: string, opts: IssueOptions = {}): Promise<{ ticket: string; expiresAt: string }> {
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
        kind: opts.kind ?? "tunnel",
        command: opts.command != null ? JSON.stringify(opts.command) : null,
      })
      .execute();
    return { ticket: secret, expiresAt: expiresAt.toISOString() };
  }

  /** Redeem a ticket for `siteName` of `kind` (default 'tunnel'). Returns the bound identity + command
   *  on success, or null if the ticket is unknown / for a DIFFERENT resource / the WRONG kind / expired
   *  / ALREADY used. Single-use + unexpired + right-resource + right-kind are all enforced in one atomic
   *  conditional UPDATE (flipping `used_at`), so a replay, a concurrent second redemption, or a
   *  cross-kind attempt can never succeed. */
  async redeem(token: string, siteName: string, kind: TicketKind = "tunnel"): Promise<RedeemedTicket | null> {
    if (!token.startsWith(TICKET_PREFIX)) return null;
    const now = this.now();
    const res = await this.db
      .updateTable("tunnel_tickets")
      .set({ used_at: now })
      .where("token_hash", "=", TunnelTicketStore.hash(token))
      .where("site_name", "=", siteName) // wrong-resource → no match → null
      .where("kind", "=", kind) // wrong-kind (exec ticket on the tunnel path, or vice versa) → null
      .where("used_at", "is", null) // single-use latch
      .where("expires_at", ">", now) // unexpired
      .returning(["email", "site_name", "kind", "command"])
      .executeTakeFirst();
    if (!res) return null;
    return { email: res.email as string, siteName: res.site_name as string, kind: res.kind as TicketKind, command: parseCommand(res.command) };
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
