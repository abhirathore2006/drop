import { test, expect } from "bun:test";
import { Hono } from "hono";
import { registerAuthRoutes } from "./auth-routes.ts";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { AuditStore } from "../audit/store.ts";
import { loadConfig } from "../config.ts";
import { hashBreakGlass } from "../auth/break-glass.ts";
import type { AuthEnv } from "../auth/middleware.ts";

const BASE = { DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y" };

async function fix(env: Record<string, string> = {}) {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const audit = new AuditStore(db);
  const cfg = loadConfig({ ...BASE, ...env });
  const app = new Hono<AuthEnv>();
  registerAuthRoutes(app, cfg, db, users, audit);
  return { db, users, audit, cfg, app };
}

test("GET /v1/auth/meta is public and reports the provider display name + break-glass flag", async () => {
  const { app, db } = await fix({ DROP_OIDC_ISSUER: "https://dev-1.okta.com", DROP_OIDC_DISPLAY_NAME: "Acme SSO" });
  const res = await app.request("/v1/auth/meta");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ displayName: "Acme SSO", breakGlass: false });
  await db.destroy();
});

test("/v1/auth/meta reflects break-glass when DROP_BREAK_GLASS_ADMIN is set", async () => {
  const { app, db } = await fix({
    DROP_SESSION_SECRET: "s".repeat(32),
    DROP_BREAK_GLASS_ADMIN: hashBreakGlass("admin@example.com", "pw"),
  });
  expect((await (await app.request("/v1/auth/meta")).json()) as { breakGlass: boolean }).toMatchObject({ breakGlass: true });
  await db.destroy();
});

test("POST /auth/start returns a generic 'SSO not configured' error when no OIDC client is set", async () => {
  const { app, db } = await fix();
  const res = await app.request("/auth/start", { method: "POST" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("DROP_OIDC");
  await db.destroy();
});

test("break-glass routes are ABSENT (404) when DROP_BREAK_GLASS_ADMIN is unset", async () => {
  const { app, db } = await fix({ DROP_SESSION_SECRET: "s".repeat(32) });
  expect((await app.request("/auth/break-glass")).status).toBe(404);
  expect((await app.request("/auth/break-glass", { method: "POST" })).status).toBe(404);
  await db.destroy();
});

test("break-glass: correct form creds mint a session cookie, redirect, and audit auth.break_glass", async () => {
  const { app, db, audit, users } = await fix({
    DROP_SESSION_SECRET: "s".repeat(32),
    DROP_BREAK_GLASS_ADMIN: hashBreakGlass("admin@example.com", "correct-pw"),
  });
  // GET renders the emergency form.
  const form = await app.request("/auth/break-glass");
  expect(form.status).toBe(200);
  expect((await form.text()).toLowerCase()).toContain("break-glass");

  const res = await app.request("/auth/break-glass", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=admin%40example.com&password=correct-pw",
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(res.headers.get("set-cookie") ?? "").toContain("drop_session=");
  // The admin was upserted and the login was audited.
  expect(await users.getUser("admin@example.com")).not.toBeNull();
  const { entries } = await audit.list({ action: "auth.break_glass" });
  expect(entries.length).toBe(1);
  expect(entries[0]!.actor).toBe("admin@example.com");
  await db.destroy();
});

test("break-glass: a wrong password is rejected with 401 and mints no session", async () => {
  const { app, db, audit } = await fix({
    DROP_SESSION_SECRET: "s".repeat(32),
    DROP_BREAK_GLASS_ADMIN: hashBreakGlass("admin@example.com", "correct-pw"),
  });
  const res = await app.request("/auth/break-glass", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=admin%40example.com&password=WRONG",
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect((await audit.list({ action: "auth.break_glass" })).entries.length).toBe(0);
  await db.destroy();
});
