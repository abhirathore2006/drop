export interface Identity {
  sub: string;
  email: string;
  /** Present iff this identity is a SERVICE-TOKEN actor (J1). Additive: session/Google identities never
   *  set it, so those flows are untouched — a human is `{sub,email}`; a token is `{sub,email,token}` with
   *  an email-like principal `token:<name>@<orgSlug>` that shows as the actor in the audit trail. */
  token?: { orgId: string; scopes: string[] };
}

export interface Verifier {
  /** Returns the identity, or null if the token is invalid. */
  verify(token: string): Promise<Identity | null>;
}
