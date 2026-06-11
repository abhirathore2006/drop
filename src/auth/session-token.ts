import { SignJWT, jwtVerify } from "jose";
import type { Identity, Verifier } from "./types.ts";

const ISSUER = "drop";

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Mints a Drop session token (HS256 JWT) for a verified identity. */
export async function signSession(secret: string, id: Identity, ttl = "30d"): Promise<string> {
  return await new SignJWT({ email: id.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(id.sub)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key(secret));
}

/** Verifies Drop session tokens the API itself issued (server-mediated login). */
export class SessionVerifier implements Verifier {
  constructor(private secret: string) {}
  async verify(token: string): Promise<Identity | null> {
    try {
      const { payload } = await jwtVerify(token, key(this.secret), { issuer: ISSUER });
      const email = typeof payload.email === "string" ? payload.email : String(payload.sub);
      return { sub: String(payload.sub), email };
    } catch {
      return null;
    }
  }
}
