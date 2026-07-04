import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { createAuthClient, verifyRequest, AuthError, AuthApiError, type FetchLike } from "./index.ts";

// ---- helpers ---------------------------------------------------------------------------------------

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

/** Sign an HS256 JWT the same way GoTrue does — the test's source of truth for round-trips. */
function sign(secret: string, payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_SECRET = "prev-secret-bbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = 1_700_000_000;

// ---- verifyRequest ---------------------------------------------------------------------------------

test("verifyRequest round-trips a valid token → user + roles + permissions + claims", async () => {
  const token = sign(SECRET, { sub: "u1", email: "a@b.co", roles: ["admin"], permissions: ["notes:write"], exp: NOW + 3600 });
  const r = await verifyRequest(token, { secret: SECRET, now: NOW });
  expect(r.user).toEqual({ id: "u1", email: "a@b.co" });
  expect(r.roles).toEqual(["admin"]);
  expect(r.permissions).toEqual(["notes:write"]);
  expect(r.claims.sub).toBe("u1");
});

test("previous-secret grace: a token signed with the old secret verifies via previousSecret", async () => {
  const token = sign(OLD_SECRET, { sub: "u2", exp: NOW + 3600 });
  const r = await verifyRequest(token, { secret: SECRET, previousSecret: OLD_SECRET, now: NOW });
  expect(r.user.id).toBe("u2");
  // …but NOT when only the current secret is offered.
  await expect(verifyRequest(token, { secret: SECRET, now: NOW })).rejects.toMatchObject({ code: "bad_signature" });
});

test("expired tokens are rejected", async () => {
  const token = sign(SECRET, { sub: "u3", exp: NOW - 1 });
  await expect(verifyRequest(token, { secret: SECRET, now: NOW })).rejects.toMatchObject({ code: "expired" });
});

test("not-yet-valid (nbf) tokens are rejected", async () => {
  const token = sign(SECRET, { sub: "u4", nbf: NOW + 100, exp: NOW + 3600 });
  await expect(verifyRequest(token, { secret: SECRET, now: NOW })).rejects.toMatchObject({ code: "not_yet_valid" });
});

test("garbage + tampered tokens are rejected", async () => {
  await expect(verifyRequest("not-a-jwt", { secret: SECRET, now: NOW })).rejects.toMatchObject({ code: "malformed" });
  await expect(verifyRequest("a.b.c.d", { secret: SECRET, now: NOW })).rejects.toMatchObject({ code: "malformed" });
  const token = sign(SECRET, { sub: "u5", exp: NOW + 3600 });
  const tampered = token.slice(0, -3) + "zzz"; // corrupt the signature
  await expect(verifyRequest(tampered, { secret: SECRET, now: NOW })).rejects.toMatchObject({ code: "bad_signature" });
  await expect(verifyRequest("", { secret: SECRET, now: NOW })).rejects.toMatchObject({ code: "no_token" });
});

test("no secret at all is a config error, not a silent pass", async () => {
  const token = sign(SECRET, { sub: "u6", exp: NOW + 3600 });
  await expect(verifyRequest(token, { now: NOW })).rejects.toBeInstanceOf(AuthError);
  await expect(verifyRequest(token, { now: NOW })).rejects.toMatchObject({ code: "no_secret" });
});

test("claims extraction: missing / non-array roles+permissions → empty arrays", async () => {
  const noClaims = sign(SECRET, { sub: "u7", exp: NOW + 3600 });
  const r1 = await verifyRequest(noClaims, { secret: SECRET, now: NOW });
  expect(r1.roles).toEqual([]);
  expect(r1.permissions).toEqual([]);
  const junk = sign(SECRET, { sub: "u8", roles: "admin", permissions: 5, exp: NOW + 3600 });
  const r2 = await verifyRequest(junk, { secret: SECRET, now: NOW });
  expect(r2.roles).toEqual([]);
  expect(r2.permissions).toEqual([]);
});

test("header extraction shapes: raw string, Fetch Request, Headers, Node req, plain object", async () => {
  const token = sign(SECRET, { sub: "u9", exp: NOW + 3600 });
  const bearer = `Bearer ${token}`;
  const shapes: unknown[] = [
    token, // raw token string
    bearer, // "Bearer <token>" string
    { headers: new Headers({ authorization: bearer }) }, // Fetch Request-like
    new Headers({ authorization: bearer }), // a Headers passed directly
    { headers: { authorization: bearer } }, // Node req-like (plain headers object)
    { authorization: bearer }, // a plain headers object passed directly
    { headers: { authorization: [bearer] } }, // header value as an array (Node can do this)
  ];
  for (const s of shapes) {
    const r = await verifyRequest(s as never, { secret: SECRET, now: NOW });
    expect(r.user.id).toBe("u9");
  }
});

// ---- createAuthClient (mocked fetch) ---------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function mockFetch(handler: (c: Call) => { ok?: boolean; status?: number; data?: unknown }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    const status = r.status ?? (r.ok === false ? 400 : 200);
    return {
      ok: r.ok ?? status < 400,
      status,
      json: async () => r.data,
      text: async () => JSON.stringify(r.data ?? ""),
    };
  };
  return { fetch, calls };
}

test("createAuthClient requires a url (or AUTH_URL)", () => {
  expect(() => createAuthClient({ url: "" })).toThrow(AuthError);
});

test("signIn → POST /token?grant_type=password with JSON body", async () => {
  const token = { access_token: "at", token_type: "bearer", expires_in: 3600, refresh_token: "rt" };
  const { fetch, calls } = mockFetch(() => ({ data: token }));
  const client = createAuthClient({ url: "https://auth--login.example.com/", fetch });
  const res = await client.signIn("a@b.co", "pw");
  expect(res).toEqual(token);
  expect(calls[0]!.url).toBe("https://auth--login.example.com/token?grant_type=password");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.headers["content-type"]).toBe("application/json");
  expect(calls[0]!.body).toEqual({ email: "a@b.co", password: "pw" });
});

test("signUp → POST /signup; refresh → POST /token?grant_type=refresh_token", async () => {
  const { fetch, calls } = mockFetch(() => ({ data: { id: "u1" } }));
  const client = createAuthClient({ url: "https://auth--login.example.com", fetch });
  await client.signUp("a@b.co", "pw");
  await client.refresh("rt");
  expect(calls[0]!.url).toBe("https://auth--login.example.com/signup");
  expect(calls[0]!.body).toEqual({ email: "a@b.co", password: "pw" });
  expect(calls[1]!.url).toBe("https://auth--login.example.com/token?grant_type=refresh_token");
  expect(calls[1]!.body).toEqual({ refresh_token: "rt" });
});

test("getUser → GET /user with bearer; signOut → POST /logout with bearer, 204 no-body", async () => {
  const { fetch, calls } = mockFetch((c) => (c.url.endsWith("/logout") ? { status: 204 } : { data: { id: "u1" } }));
  const client = createAuthClient({ url: "https://auth--login.example.com", fetch });
  const user = await client.getUser("at");
  expect(user).toEqual({ id: "u1" });
  expect(calls[0]!.method).toBe("GET");
  expect(calls[0]!.url).toBe("https://auth--login.example.com/user");
  expect(calls[0]!.headers["authorization"]).toBe("Bearer at");

  await client.signOut("at");
  expect(calls[1]!.method).toBe("POST");
  expect(calls[1]!.url).toBe("https://auth--login.example.com/logout");
  expect(calls[1]!.headers["authorization"]).toBe("Bearer at");
  expect(calls[1]!.body).toBeUndefined(); // no JSON body on logout
});

test("a non-2xx response throws AuthApiError carrying status + detail", async () => {
  const { fetch } = mockFetch(() => ({ status: 400, data: { error: "invalid_grant" } }));
  const client = createAuthClient({ url: "https://auth--login.example.com", fetch });
  await expect(client.signIn("a@b.co", "bad")).rejects.toBeInstanceOf(AuthApiError);
  await expect(client.signIn("a@b.co", "bad")).rejects.toMatchObject({ status: 400, detail: { error: "invalid_grant" } });
});
