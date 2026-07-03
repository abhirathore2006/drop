import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { LockStore, LockHeldError } from "./lock.ts";

// A mutable fake clock so lease expiry is deterministic (no real waiting).
function clock(start = 0) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

test("acquire is exclusive: a held key rejects a different holder, same holder refreshes", async () => {
  const db = await makeTestDb();
  const lock = new LockStore(db);
  expect(await lock.acquire("deploy:app", "a", 60_000)).toBe(true);
  expect(await lock.acquire("deploy:app", "b", 60_000)).toBe(false); // contended by a live holder
  expect(await lock.acquire("deploy:app", "a", 60_000)).toBe(true); // reentrant refresh by the holder
  await db.destroy();
});

test("acquire steals an EXPIRED lease", async () => {
  const db = await makeTestDb();
  const c = clock();
  const lock = new LockStore(db, c.now);
  expect(await lock.acquire("k", "a", 1000)).toBe(true);
  expect(await lock.acquire("k", "b", 1000)).toBe(false); // still live
  c.advance(1500); // a's lease expired
  expect(await lock.acquire("k", "b", 1000)).toBe(true); // b steals it
  expect(await lock.acquire("k", "a", 1000)).toBe(false); // now b holds it
  await db.destroy();
});

test("release frees the key (and only the holder's release counts)", async () => {
  const db = await makeTestDb();
  const lock = new LockStore(db);
  await lock.acquire("k", "a", 60_000);
  await lock.release("k", "b"); // not the holder → no-op
  expect(await lock.acquire("k", "b", 60_000)).toBe(false); // still a's
  await lock.release("k", "a"); // the holder frees it
  expect(await lock.acquire("k", "b", 60_000)).toBe(true);
  await db.destroy();
});

test("withLock runs fn then releases; a held key throws LockHeldError", async () => {
  const db = await makeTestDb();
  const lock = new LockStore(db);
  let ran = false;
  const out = await lock.withLock("k", 60_000, async () => {
    ran = true;
    return 42;
  });
  expect(ran).toBe(true);
  expect(out).toBe(42);
  // released after the body → can be taken again
  expect(await lock.acquire("k", "x", 60_000)).toBe(true);
  // now held by x → withLock throws
  await expect(lock.withLock("k", 60_000, async () => "never")).rejects.toBeInstanceOf(LockHeldError);
  await db.destroy();
});

test("withLock releases even when fn throws", async () => {
  const db = await makeTestDb();
  const lock = new LockStore(db);
  await expect(
    lock.withLock("k", 60_000, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await lock.acquire("k", "y", 60_000)).toBe(true); // released despite the throw
  await db.destroy();
});
