// Service-token verifier (J1). Slots into the SAME Verifier chain as SessionVerifier / GoogleVerifier
// (see bin/api.ts) so `Authorization: Bearer drop_st_…` is handled alongside human logins — no change to
// authMiddleware, so session flows are untouched. It returns null for any non-`drop_st_` token, letting
// the chain fall through to the next verifier; for a valid service token it mints a TOKEN-ACTOR identity
// whose email-like principal `token:<name>@<orgSlug>` becomes the audit actor, carrying its org + scopes.
import type { Identity, Verifier } from "./types.ts";
import type { OrgStore } from "../orgs/store.ts";
import { TOKEN_PREFIX, type ServiceTokenStore } from "../tokens/store.ts";

export class TokenVerifier implements Verifier {
  constructor(private tokens: ServiceTokenStore, private orgs: OrgStore) {}

  async verify(token: string): Promise<Identity | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null; // not ours → next verifier in the chain
    const v = await this.tokens.verify(token); // hash lookup + expiry + soft-revocation check
    if (!v) return null; // unknown / revoked / expired → 401
    // Build the audit-visible principal `token:<name>@<orgSlug>`. The org row always exists (org delete
    // cascades the token away), but fall back to the org id if it somehow doesn't.
    const org = await this.orgs.getOrg(v.orgId);
    const email = `token:${v.name}@${org?.slug ?? v.orgId}`;
    return { sub: v.tokenId, email, token: { orgId: v.orgId, scopes: v.scopes } };
  }
}
