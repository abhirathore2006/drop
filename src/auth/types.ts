export interface Identity {
  sub: string;
  email: string;
}

export interface Verifier {
  /** Returns the identity, or null if the token is invalid. */
  verify(token: string): Promise<Identity | null>;
}
