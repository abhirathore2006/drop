import { sql } from "kysely";
import type { Db } from "../db/db.ts";

export interface User {
  email: string;
  name: string | null;
  role: "admin" | "member";
  status: "active" | "suspended";
}

const SELECT = ["email", "name", "role", "status"] as const;

export class UserStore {
  constructor(private db: Db) {}

  /** Create-or-update on login. Never downgrades role; refreshes name (if given) + last_login_at.
   *  Email is the canonical (lowercased) principal — the request middleware lowercases the
   *  identity everywhere, so the users table MUST be keyed the same or lookups (suspension,
   *  membership) silently miss for a mixed-case IdP email. */
  async upsertOnLogin(rawEmail: string, name: string | null): Promise<User> {
    const email = rawEmail.toLowerCase();
    const row = await this.db
      .insertInto("users")
      .values({ email, name, last_login_at: sql`now()` })
      .onConflict((oc) =>
        oc.column("email").doUpdateSet({
          name: sql`coalesce(excluded.name, users.name)`,
          last_login_at: sql`now()`,
        }),
      )
      .returning(SELECT)
      .executeTakeFirstOrThrow();
    return row as User;
  }

  async getUser(email: string): Promise<User | null> {
    const r = await this.db.selectFrom("users").select(SELECT).where("email", "=", email.toLowerCase()).executeTakeFirst();
    return (r as User | undefined) ?? null;
  }

  async setRole(email: string, role: "admin" | "member"): Promise<void> {
    await this.db.updateTable("users").set({ role }).where("email", "=", email.toLowerCase()).execute();
  }

  /** Suspend (deny all access) or reactivate a user. Returns false if no such user. */
  async setStatus(email: string, status: "active" | "suspended"): Promise<boolean> {
    const res = await this.db.updateTable("users").set({ status }).where("email", "=", email.toLowerCase()).executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0) > 0;
  }

  /** Ensure each email exists with role=admin (boot bootstrap; idempotent; never demotes others). */
  async seedAdmins(emails: string[]): Promise<void> {
    for (const raw of emails) {
      const email = raw.toLowerCase();
      await this.db
        .insertInto("users")
        .values({ email, name: null, role: "admin" })
        .onConflict((oc) => oc.column("email").doUpdateSet({ role: "admin" }))
        .execute();
    }
  }

  async listUsers(): Promise<User[]> {
    return (await this.db.selectFrom("users").select(SELECT).orderBy("email").execute()) as User[];
  }
}
