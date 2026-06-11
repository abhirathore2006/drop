import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Identity, Verifier } from "./types.ts";

/** Maps tokens → identities. For tests. */
export class FakeVerifier implements Verifier {
  constructor(private map: Record<string, Identity>) {}
  async verify(token: string): Promise<Identity | null> {
    return this.map[token] ?? null;
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
 */
export function checkDomain(email: string, hd: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = (hd && hd.length > 0 ? hd : email.split("@")[1]) ?? "";
  return allowed.includes(domain);
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
