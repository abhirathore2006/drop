import { test, expect } from "bun:test";
import { can, type Action, type Actor } from "./permissions.ts";

const ALL: Action[] = ["read", "publish", "rollback", "configure", "share", "transfer", "delete"];
const owner: Actor = { email: "o@x.com", platformRole: "member", siteRole: "owner" };
const editor: Actor = { email: "e@x.com", platformRole: "member", siteRole: "editor" };
const viewer: Actor = { email: "v@x.com", platformRole: "member", siteRole: "viewer" };
const stranger: Actor = { email: "s@x.com", platformRole: "member", siteRole: null };
const admin: Actor = { email: "a@x.com", platformRole: "admin", siteRole: null };

test("owner can do everything", () => {
  for (const a of ALL) expect(can(owner, a)).toBe(true);
});

test("editor can publish/rollback/read only", () => {
  expect(can(editor, "publish")).toBe(true);
  expect(can(editor, "rollback")).toBe(true);
  expect(can(editor, "read")).toBe(true);
  for (const a of ["configure", "share", "transfer", "delete"] as const) expect(can(editor, a)).toBe(false);
});

test("viewer can only read", () => {
  expect(can(viewer, "read")).toBe(true);
  for (const a of ["publish", "rollback", "configure", "share", "transfer", "delete"] as const)
    expect(can(viewer, a)).toBe(false);
});

test("non-member can do nothing", () => {
  for (const a of ALL) expect(can(stranger, a)).toBe(false);
});

test("platform admin can do everything regardless of site role", () => {
  for (const a of ALL) expect(can(admin, a)).toBe(true);
});
