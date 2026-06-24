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

test("--org is on the create/filter/re-home commands, NOT on per-resource ops", () => {
  const p = buildProgram();
  const cmd = (name: string) => p.commands.find((c) => c.name() === name)!;
  const hasOrg = (name: string) => cmd(name).options.some((o) => o.long === "--org");
  // create targets + the list filter + transfer re-home take --org
  for (const n of ["publish", "deploy", "push", "ls", "transfer"]) expect(hasOrg(n)).toBe(true);
  // per-resource ops identify a globally-unique name → no --org
  for (const n of ["share", "unshare", "info", "rm", "rollback", "restart", "stop", "start"]) expect(hasOrg(n)).toBe(false);
  // transfer takes an OPTIONAL email (email OR --org)
  expect(cmd("transfer").registeredArguments.some((a: any) => a.name() === "email" && !a.required)).toBe(true);
});

test("`update` is a top-level command (self-updates the CLI)", () => {
  const p = buildProgram();
  expect(p.commands.map((c) => c.name())).toContain("update");
});
