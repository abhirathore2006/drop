import { randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";

/** Thrown by withLock when the lock is currently held by someone else (a live, unexpired lease). */
export class LockHeldError extends Error {
  readonly name = "LockHeldError";
  constructor(readonly key: string) {
    super(`lock is held: ${key}`);
  }
}

/**
 * A tiny lease-based advisory lock over a `locks(key, holder, expires_at)` row. Serializes work that
 * must not interleave across API instances — deploys/release Jobs per app now (`deploy:<app>`), and
 * later stack `up` runs (`stack:<id>`). Leases expire so a crashed holder can't wedge the key forever.
 *
 * `now` is injectable so expiry is deterministic in tests; the steal comparison uses a JS timestamp
 * (not SQL now()) so app + DB clocks can't disagree.
 */
export class LockStore {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /** Take (or refresh) the lock. Returns true on success; false when a DIFFERENT holder's lease is
   *  still live. Insert-or-steal-if-expired in one statement: ON CONFLICT DO UPDATE only fires when
   *  the existing lease is expired OR the caller already holds it, so a held key leaves the row
   *  untouched and RETURNING yields no row. */
  async acquire(key: string, holder: string, ttlMs: number): Promise<boolean> {
    const nowTs = this.now();
    const expiresAt = new Date(nowTs.getTime() + ttlMs);
    const row = await this.db
      .insertInto("locks")
      .values({ key, holder, expires_at: expiresAt })
      .onConflict((oc) =>
        oc
          .column("key")
          .doUpdateSet({ holder, expires_at: expiresAt })
          .where((eb) => eb.or([eb("locks.expires_at", "<", nowTs), eb("locks.holder", "=", holder)])),
      )
      .returning("key")
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Release the lock IF the caller still holds it (a stolen/expired lock isn't clobbered). */
  async release(key: string, holder: string): Promise<void> {
    await this.db.deleteFrom("locks").where("key", "=", key).where("holder", "=", holder).execute();
  }

  /** Run `fn` while holding `key`; throws LockHeldError immediately if it's held. Always releases. */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const holder = randomBytes(12).toString("hex");
    if (!(await this.acquire(key, holder, ttlMs))) throw new LockHeldError(key);
    try {
      return await fn();
    } finally {
      await this.release(key, holder);
    }
  }
}
