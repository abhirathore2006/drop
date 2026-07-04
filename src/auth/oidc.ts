import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Identity, Verifier } from "./types.ts";

/** Maps tokens → identities. For tests. */
export class FakeVerifier implements Verifier {
  constructor(private map: Record<string, Identity>) {}
  async verify(token: string): Promise<Identity | null> {
    return this.map[token] ?? null;
  }
}

/** Tries verifiers in order; returns the first identity, or null. */
export class ChainVerifier implements Verifier {
  constructor(private verifiers: Verifier[]) {}
  async verify(token: string): Promise<Identity | null> {
    for (const v of this.verifiers) {
      const id = await v.verify(token);
      if (id) return id;
    }
    return null;
  }
}

/** Trusts a "sub:email" token. LOCAL DEV ONLY (DROP_DEV_AUTH=1). */
export class DevHeaderVerifier implements Verifier {
  async verify(token: string): Promise<Identity | null> {
    const i = token.indexOf(":");
    if (i <= 0) return null;
    return { sub: token.slice(0, i), email: token.slice(i + 1) };
  }
}

/**
 * True if the account's domain is allowed. Empty allowlist → any domain.
 * Prefers the Google `hd` (hosted-domain) claim, falling back to the email domain.
 * Callers pass `hd` ONLY for the Google issuer — every other issuer passes `undefined`,
 * so the check falls back to the email-domain suffix (see mapClaims / config.isGoogleIssuer).
 */
export function checkDomain(email: string, hd: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = (hd && hd.length > 0 ? hd : email.split("@")[1]) ?? "";
  return allowed.includes(domain);
}

/**
 * True if `required` is present in the OIDC groups claim. The claim value may be an ARRAY
 * (Keycloak, Authentik, Entra) or a SPACE-joined STRING (some Okta / custom setups) — both handled.
 * A missing/empty claim → no groups → false when a group is required.
 */
export function checkGroup(claimValue: unknown, required: string): boolean {
  const groups = Array.isArray(claimValue)
    ? claimValue.map((g) => String(g))
    : typeof claimValue === "string"
      ? claimValue.split(/\s+/).filter(Boolean)
      : [];
  return groups.includes(required);
}

export interface ClaimMapOptions {
  emailClaim: string; // which claim holds the email principal (config DROP_OIDC_EMAIL_CLAIM)
  nameClaim: string; // which claim holds the display name (config DROP_OIDC_NAME_CLAIM)
  allowedDomains: string[]; // domain gate; empty = any
  allowedEmails: string[]; // per-email allowlist (lowercased); empty = no per-email restriction
  isGoogle: boolean; // issuer is Google → trust the `hd` claim for the domain gate
  groupsClaim?: string; // which claim carries groups (config DROP_OIDC_GROUPS_CLAIM)
  requiredGroup?: string; // when set, login requires this group (config DROP_OIDC_REQUIRED_GROUP)
}

export type ClaimMapResult = { ok: true; email: string; name: string | null } | { ok: false; error: string };

/**
 * Issuer-generic claim mapping + gates for the server-mediated callback. Pure (no I/O) so it's the
 * testable seam for the whole login policy. Rules:
 *  - email: taken from `emailClaim`; MISSING/non-string → reject.
 *  - email_verified: rejected ONLY when the claim EXISTS and is exactly `false` (many non-Google IdPs
 *    omit it for already-verified corp accounts — absence is not a rejection).
 *  - domain gate: Google trusts the `hd` claim; every other issuer uses the email-domain suffix.
 *  - per-email allowlist (config allowedEmails) applied on top of the domain gate.
 *  - group gate: when requiredGroup is set, the groups claim must contain it (array or space-string).
 */
export function mapClaims(claims: Record<string, unknown>, opts: ClaimMapOptions): ClaimMapResult {
  const rawEmail = claims[opts.emailClaim];
  const email = typeof rawEmail === "string" ? rawEmail : "";
  if (!email) return { ok: false, error: `login token is missing the '${opts.emailClaim}' claim` };
  // Reject only an EXPLICIT false — an absent email_verified is allowed (non-Google IdPs often omit it).
  if (claims.email_verified === false) return { ok: false, error: "email address is not verified" };
  const rawName = claims[opts.nameClaim];
  const name = typeof rawName === "string" ? rawName : null;
  const hd = opts.isGoogle && typeof claims.hd === "string" ? (claims.hd as string) : undefined;
  if (!checkDomain(email, hd, opts.allowedDomains)) return { ok: false, error: "your email domain isn't allowed" };
  if (opts.allowedEmails.length > 0 && !opts.allowedEmails.includes(email.toLowerCase())) {
    return { ok: false, error: "your account isn't on the allowlist" };
  }
  if (opts.requiredGroup && !checkGroup(claims[opts.groupsClaim ?? "groups"], opts.requiredGroup)) {
    return { ok: false, error: `you must be a member of the '${opts.requiredGroup}' group` };
  }
  return { ok: true, email, name };
}

export interface GoogleVerifierOptions {
  audience: string; // Google OAuth client ID
  allowedDomains: string[]; // empty = any Google account
}

/** Validates a Google ID token (JWT) and enforces the domain allowlist. */
export class GoogleVerifier implements Verifier {
  private jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  constructor(private opts: GoogleVerifierOptions) {}

  async verify(token: string): Promise<Identity | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: this.opts.audience,
      });
      if (payload.email_verified !== true) return null;
      const email = typeof payload.email === "string" ? payload.email : "";
      if (!email) return null;
      const hd = typeof payload.hd === "string" ? payload.hd : undefined;
      if (!checkDomain(email, hd, this.opts.allowedDomains)) return null;
      // Principal identifier is the verified email (Google `sub` is opaque).
      return { sub: email, email };
    } catch {
      return null;
    }
  }
}
