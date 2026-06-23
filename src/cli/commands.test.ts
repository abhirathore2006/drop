import { test, expect } from "bun:test";
import { buildProgram } from "./commands.ts";

test("db is a command group with create + password subcommands (colon commands removed)", () => {
  const p = buildProgram();
  const top = p.commands.map((c) => c.name());
  expect(top).toContain("db");
  expect(top).not.toContain("db:create"); // moved under `db`
  expect(top).not.toContain("db:password");

  const db = p.commands.find((c) => c.name() === "db")!;
  const subs = db.commands.map((c) => c.name());
  expect(subs).toContain("create");
  expect(subs).toContain("password");

  // the create subcommand keeps --org; password keeps --password-stdin
  const create = db.commands.find((c) => c.name() === "create")!;
  expect(create.options.some((o) => o.long === "--org")).toBe(true);
  const password = db.commands.find((c) => c.name() === "password")!;
  expect(password.options.some((o) => o.long === "--password-stdin")).toBe(true);
});
