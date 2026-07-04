import { test, expect } from "bun:test";
import { Hono } from "hono";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { ServiceTokenStore } from "../tokens/store.ts";
import { TokenVerifier } from "./token-verifier.ts";
import { FakeVerifier, ChainVerifier } from "./oidc.ts";
import { authMiddleware, type AuthEnv } from "./middleware.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@x.com");
  const tokens = new ServiceTokenStore(db);
  return { db, orgs, org, tokens };
}

test("TokenVerifier: a drop_st_ secret resolves to a token-actor identity (token:<name>@<slug>)", async () => {
  const { db, orgs, org, tokens } = await fix();
  const { token } = await tokens.create(org.id, "ci-deploy", ["deploy:myapp"], null, "alice@x.com");
  const v = new TokenVerifier(tokens, orgs);
  const id = await v.verify(token);
  expect(id).not.toBeNull();
  expect(id!.email).toBe(`token:ci-deploy@${org.slug}`);
  expect(id!.sub).toMatch(/^st_/);
  expect(id!.token).toEqual({ orgId: org.id, scopes: ["deploy:myapp"] });
  // a non-service token is not ours → null (the chain falls through to the next verifier)
  expect(await v.verify("aGoogleJwt")).toBeNull();
  await db.destroy();
});

test("middleware branch: drop_st_ token injects the token identity; junk → 401", async () => {
  const { db, orgs, org, tokens } = await fix();
  const { token } = await tokens.create(org.id, "ci", ["publish:*"], null, "alice@x.com");
  const fake = new FakeVerifier({ human: { sub: "h", email: "human@x.com" } });
  const app = new Hono<AuthEnv>();
  app.use("/x", authMiddleware(new ChainVerifier([new TokenVerifier(tokens, orgs), fake])));
  app.get("/x", (c) => {
    const i = c.get("identity");
    return c.json({ email: i.email, token: i.token ?? null });
  });

  const ok = await app.request("/x", { headers: { authorization: `Bearer ${token}` } });
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { email: string; token: unknown };
  expect(body.email).toBe(`token:ci@${org.slug}`);
  expect(body.token).toEqual({ orgId: org.id, scopes: ["publish:*"] });

  // a human token still works through the same chain
  expect((await app.request("/x", { headers: { authorization: "Bearer human" } })).status).toBe(200);
  // junk → 401
  expect((await app.request("/x", { headers: { authorization: "Bearer drop_st_deadbeef" } })).status).toBe(401);
  expect((await app.request("/x", { headers: { authorization: "Bearer nonsense" } })).status).toBe(401);
  await db.destroy();
});
