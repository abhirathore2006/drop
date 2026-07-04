import { test, expect } from "bun:test";
import {
  RBAC_TABLES,
  RBAC_TABLES_SQL,
  RBAC_HOOK_FUNCTION_SQL,
  RBAC_HOOK_URI,
  RBAC_HOOK_ENABLED_ENV,
  RBAC_HOOK_URI_ENV,
  rbacHookEnv,
  rbacSeedSql,
} from "./rbac-seed.ts";
import { GoTrueEngine } from "./gotrue.ts";
import { sanitizeAuthConfig } from "../auth-config.ts";

test("the seed declares the three Supabase-pattern tables (users↔roles↔permissions, both hops)", () => {
  for (const t of Object.values(RBAC_TABLES)) {
    expect(RBAC_TABLES_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
  }
  // both many-to-many hops present as FKs
  expect(RBAC_TABLES_SQL).toContain(`REFERENCES ${RBAC_TABLES.roles} (id)`);
  expect(RBAC_TABLES_SQL).toContain("user_id uuid");
});

test("all DDL is idempotent (safe to re-apply)", () => {
  const sql = rbacSeedSql("login");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
  expect(sql).toContain("CREATE OR REPLACE FUNCTION");
  expect(sql).not.toContain("CREATE TABLE app_roles ("); // never a bare (non-idempotent) CREATE TABLE
  expect(sql).toContain('auth resource "login"'); // header names the resource
});

test("the claims hook joins both tables on event->>'user_id' and stamps roles + permissions", () => {
  expect(RBAC_HOOK_FUNCTION_SQL).toContain("public.drop_access_token_hook(event jsonb)");
  expect(RBAC_HOOK_FUNCTION_SQL).toContain("RETURNS jsonb");
  expect(RBAC_HOOK_FUNCTION_SQL).toContain("event ->> 'user_id'");
  expect(RBAC_HOOK_FUNCTION_SQL).toContain("'{roles}'");
  expect(RBAC_HOOK_FUNCTION_SQL).toContain("'{permissions}'");
  // returns the modified event (GoTrue custom-access-token contract), not a bare claims object
  expect(RBAC_HOOK_FUNCTION_SQL).toContain("jsonb_set(event, '{claims}', claims)");
});

test("hook URI matches the seeded function; DB segment is the ignored `postgres` convention", () => {
  expect(RBAC_HOOK_URI).toBe("pg-functions://postgres/public/drop_access_token_hook");
  expect(rbacHookEnv()).toEqual({
    [RBAC_HOOK_ENABLED_ENV]: "true",
    [RBAC_HOOK_URI_ENV]: RBAC_HOOK_URI,
  });
});

test("GoTrue engine emits the hook env ONLY when rbac: true", () => {
  const engine = new GoTrueEngine();
  const ctx = (rbac: boolean) => ({
    name: "login",
    apiExternalUrl: "https://auth--login.example.com",
    config: sanitizeAuthConfig({ rbac })!,
  });
  const withRbac = engine.envFor(ctx(true));
  expect(withRbac[RBAC_HOOK_ENABLED_ENV]).toBe("true");
  expect(withRbac[RBAC_HOOK_URI_ENV]).toBe(RBAC_HOOK_URI);

  const withoutRbac = engine.envFor(ctx(false));
  expect(withoutRbac[RBAC_HOOK_ENABLED_ENV]).toBeUndefined();
  expect(withoutRbac[RBAC_HOOK_URI_ENV]).toBeUndefined();
});
