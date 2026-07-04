// (B3) StackLinkStore — CRUD + the partial sync-state update the poller writes. PGlite-backed like the
// sibling store tests; rows FK onto stacks (cascade) + users (created_by), so both are seeded first.
import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { StackStore } from "../stacks/store.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { StackLinkStore } from "./store.ts";

async function setup() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@example.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@example.com");
  const stacks = new StackStore(db);
  const stack = await stacks.create({ name: "shop", orgId: org.id, spec: { name: "shop", resources: { db: { type: "database" } } }, createdBy: "alice@example.com" });
  return { db, stacks, stack, links: new StackLinkStore(db) };
}

test("B3 store: link/get/list/unlink CRUD; defaults + token round-trip; unlink is idempotent-honest", async () => {
  const { db, stack, links } = await setup();

  expect(await links.get(stack.id)).toBeNull();
  expect(await links.list()).toEqual([]);

  const row = await links.link({ stackId: stack.id, repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml", token: "ghp_secret", dryRunOnly: false, createdBy: "Alice@Example.com" });
  expect(row.stackId).toBe(stack.id);
  expect(row.repo).toBe("https://github.com/acme/shop");
  expect(row.branch).toBe("main");
  expect(row.path).toBe("drop.yaml");
  expect(row.token).toBe("ghp_secret"); // stored for the poller's auth header; the API layer masks it
  expect(row.dryRunOnly).toBe(false);
  expect(row.createdBy).toBe("alice@example.com"); // canonical lowercase
  expect(row.lastSha).toBeNull();
  expect(row.lastStatus).toBeNull();
  expect(row.pendingSha).toBeNull();

  expect((await links.get(stack.id))!.repo).toBe("https://github.com/acme/shop");
  expect((await links.list()).map((l) => l.stackId)).toEqual([stack.id]);

  expect(await links.unlink(stack.id)).toBe(true);
  expect(await links.unlink(stack.id)).toBe(false); // second unlink reports "nothing there"
  expect(await links.get(stack.id)).toBeNull();
  await db.destroy();
});

test("B3 store: re-link REPLACES the config and resets the sync state (fresh first poll re-applies)", async () => {
  const { db, stack, links } = await setup();
  await links.link({ stackId: stack.id, repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml", token: "t1", dryRunOnly: false, createdBy: "alice@example.com" });
  await links.updateSyncState(stack.id, { lastSha: "abc", lastStatus: "synced", lastSyncedAt: new Date(), pendingSha: "p1" });

  const relinked = await links.link({ stackId: stack.id, repo: "https://gitlab.com/acme/shop", branch: "release", path: "deploy/drop.yaml", token: null, dryRunOnly: true, createdBy: "alice@example.com" });
  expect(relinked.repo).toBe("https://gitlab.com/acme/shop");
  expect(relinked.branch).toBe("release");
  expect(relinked.path).toBe("deploy/drop.yaml");
  expect(relinked.token).toBeNull(); // re-linking without a token clears the old one
  expect(relinked.dryRunOnly).toBe(true);
  // sync state reset: the next poll treats it as never-synced
  expect(relinked.lastSha).toBeNull();
  expect(relinked.lastStatus).toBeNull();
  expect(relinked.lastError).toBeNull();
  expect(relinked.lastSyncedAt).toBeNull();
  expect(relinked.pendingSha).toBeNull();
  await db.destroy();
});

test("B3 store: updateSyncState writes ONLY the provided keys (explicit null clears; absent untouched)", async () => {
  const { db, stack, links } = await setup();
  await links.link({ stackId: stack.id, repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml", token: null, dryRunOnly: false, createdBy: "alice@example.com" });

  const when = new Date("2026-07-01T12:00:00Z");
  await links.updateSyncState(stack.id, { lastSha: "sha1", lastStatus: "synced", lastError: null, lastSyncedAt: when });
  let row = (await links.get(stack.id))!;
  expect(row.lastSha).toBe("sha1");
  expect(row.lastStatus).toBe("synced");
  expect(row.lastSyncedAt).toBe(when.toISOString());

  // a failure patch touches status+error but NOT last_sha/last_synced_at
  await links.updateSyncState(stack.id, { lastStatus: "failed", lastError: "boom" });
  row = (await links.get(stack.id))!;
  expect(row.lastSha).toBe("sha1");
  expect(row.lastStatus).toBe("failed");
  expect(row.lastError).toBe("boom");
  expect(row.lastSyncedAt).toBe(when.toISOString());

  // pending-review parking (dry-run-only), then a clearing apply
  await links.updateSyncState(stack.id, { pendingSha: "sha2", lastStatus: "pending_review", lastError: null });
  row = (await links.get(stack.id))!;
  expect(row.pendingSha).toBe("sha2");
  expect(row.lastStatus).toBe("pending_review");
  expect(row.lastError).toBeNull();
  await links.updateSyncState(stack.id, { lastSha: "sha2", lastStatus: "synced", pendingSha: null });
  row = (await links.get(stack.id))!;
  expect(row.lastSha).toBe("sha2");
  expect(row.pendingSha).toBeNull();

  await links.updateSyncState(stack.id, {}); // empty patch is a no-op, not an error
  await db.destroy();
});

test("B3 store: the link cascades away with its stack", async () => {
  const { db, stacks, stack, links } = await setup();
  await links.link({ stackId: stack.id, repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml", token: null, dryRunOnly: false, createdBy: "alice@example.com" });
  await stacks.delete(stack.id);
  expect(await links.get(stack.id)).toBeNull();
  expect(await links.list()).toEqual([]);
  await db.destroy();
});
