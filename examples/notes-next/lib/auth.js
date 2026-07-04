// @drop/auth wiring for the notes app (K2). AUTH_URL + AUTH_JWT_SECRET are injected by Drop when you
// bind the managed auth resource — `uses: [{ auth: auth }]` in this stack's drop.yaml. The client is
// created lazily (per call) so `next build` never needs AUTH_URL present at build time; verifyRequest
// reads AUTH_JWT_SECRET at request time.
import { createAuthClient } from "@drop/auth";

// The access token is kept in a cookie the server components read. Short-lived — its lifetime matches
// the JWT TTL (1h default). A real app would set HttpOnly/Secure from a route handler; this fixture
// keeps it minimal.
export const SESSION_COOKIE = "drop_at";

/** A GoTrue REST client bound to this app's auth resource (reads AUTH_URL). */
export function getAuthClient() {
  return createAuthClient();
}
