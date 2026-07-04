// Service accounts / scoped CI tokens (J1). The single seam over the `service_tokens` table.
//
// A token is an ORG-owned bearer credential for automation (CI), NOT tied to a person: it survives
// when its creator leaves, is auditable as automation, and carries only the scopes it was granted.
// The secret has the shape `drop_st_<48 hex>` and is shown ONCE at create; only its sha256 hash is
// stored, so a leaked DB never yields a usable token. verify() is a single indexed hash lookup (cheap
// per request → revocation/suspension is instant), with an expiry + soft-revocation check and a
// throttled last-used bump. The scope grammar + `scopeAllows` live in authz/permissions.ts (they are
// about the permission verbs); re-exported here so token code + tests import them from one place.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";
import { validateScopes, scopeAllows, parseScope, ACTIONS } from "../authz/permissions.ts";

export { validateScopes, scopeAllows, parseScope, ACTIONS };

/** Secret prefix — the branch signal for the auth chain (`Authorization: Bearer drop_st_…`). */
export const TOKEN_PREFIX = "drop_st_";
/** last_used_at is bumped at most once per this window (a hot CI token shouldn't write every request). */
const LAST_USED_THROTTLE_MS = 60_000;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const parseScopes = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : typeof v === "string" ? (JSON.parse(v) as string[]) : []);

/** A token row as returned to the console/CLI — NEVER includes the hash or the secret. */
export interface ServiceToken {
  id: string;
  orgId: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The result of a successful verify — the identity material the auth layer needs. */
export interface VerifiedToken {
  orgId: string;
  tokenId: string;
  name: string;
  scopes: string[];
}

export class ServiceTokenStore {
  // `now` is injectable so tests can drive expiry + the last-used throttle deterministically.
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  private static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private toToken(r: Record<string, unknown>): ServiceToken {
    return {
      id: r.id as string,
      orgId: r.org_id as string,
      name: r.name as string,
      scopes: parseScopes(r.scopes),
      expiresAt: r.expires_at == null ? null : iso(r.expires_at),
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at),
      lastUsedAt: r.last_used_at == null ? null : iso(r.last_used_at),
      revokedAt: r.revoked_at == null ? null : iso(r.revoked_at),
    };
  }

  /** Mint a token. Returns the secret ONCE (never recoverable afterward) plus the stored row. Callers
   *  MUST validate `scopes` (validateScopes) before this; passing bad scopes just stores bad rows. */
  async create(orgId: string, name: string, scopes: string[], expiresAt: Date | null, createdBy: string): Promise<{ token: string; row: ServiceToken }> {
    const secret = TOKEN_PREFIX + randomBytes(24).toString("hex"); // drop_st_<48 hex>
    const id = "st_" + randomBytes(12).toString("hex");
    await this.db
      .insertInto("service_tokens")
      .values({
        id,
        org_id: orgId,
        name,
        scopes: JSON.stringify(scopes),
        token_hash: ServiceTokenStore.hash(secret),
        expires_at: expiresAt ?? null,
        created_by: createdBy.toLowerCase(),
        created_at: this.now(),
        last_used_at: null,
        revoked_at: null,
      })
      .execute();
    const row = (await this.get(id))!;
    return { token: secret, row };
  }

  /** Resolve a bearer secret to its token identity, or null if it's not a service token / unknown /
   *  revoked / expired. On a live token, bumps last_used_at at most ~1/min (best-effort; never throws). */
  async verify(token: string): Promise<VerifiedToken | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null; // not a service token → let the chain try the next verifier
    const r = await this.db.selectFrom("service_tokens").selectAll().where("token_hash", "=", ServiceTokenStore.hash(token)).executeTakeFirst();
    if (!r) return null;
    if (r.revoked_at != null) return null; // soft-revoked → 401 (revocation is immediate)
    const now = this.now();
    if (r.expires_at != null && ms(r.expires_at) <= now.getTime()) return null; // expired → 401
    // Throttled last-used bump: only write when the last mark is missing or older than the window.
    if (r.last_used_at == null || now.getTime() - ms(r.last_used_at) >= LAST_USED_THROTTLE_MS) {
      await this.db.updateTable("service_tokens").set({ last_used_at: now }).where("id", "=", r.id).execute().catch(() => {});
    }
    return { orgId: r.org_id, tokenId: r.id, name: r.name, scopes: parseScopes(r.scopes) };
  }

  /** Soft-revoke a token (marks revoked_at; the row stays for audit). Returns false if already revoked
   *  or unknown. Idempotent — a second revoke is a no-op false. */
  async revoke(id: string): Promise<boolean> {
    const res = await this.db
      .updateTable("service_tokens")
      .set({ revoked_at: this.now() })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  /** One token by id (or null). Never includes the hash. */
  async get(id: string): Promise<ServiceToken | null> {
    const r = await this.db.selectFrom("service_tokens").selectAll().where("id", "=", id).executeTakeFirst();
    return r ? this.toToken(r as Record<string, unknown>) : null;
  }

  /** All of an org's tokens, newest first. NO hashes/secrets — safe to return to the console/CLI. */
  async list(orgId: string): Promise<ServiceToken[]> {
    const rows = await this.db.selectFrom("service_tokens").selectAll().where("org_id", "=", orgId).orderBy("created_at", "desc").execute();
    return rows.map((r) => this.toToken(r as Record<string, unknown>));
  }
}
