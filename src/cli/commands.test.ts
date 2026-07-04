import { test, expect } from "bun:test";
import { buildProgram } from "./commands.ts";
import { VERSION } from "../version.ts";

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

test("expose is a group (ls + default set) with unexpose top-level + db expose sugar (A2b)", () => {
  const p = buildProgram();
  const top = p.commands.map((c) => c.name());
  expect(top).toContain("expose");
  expect(top).toContain("unexpose");
  const expose = p.commands.find((c) => c.name() === "expose")!;
  const subs = expose.commands.map((c) => c.name());
  expect(subs).toContain("ls");
  // the default (name) subcommand carries --sni/--port/--protocol; ls carries --org
  const set = expose.commands.find((c) => c.name() === "set")!;
  for (const o of ["--sni", "--port", "--protocol"]) expect(set.options.some((x) => x.long === o)).toBe(true);
  expect(expose.commands.find((c) => c.name() === "ls")!.options.some((o) => o.long === "--org")).toBe(true);
  // `drop db expose <db>` sugar
  const db = p.commands.find((c) => c.name() === "db")!;
  expect(db.commands.map((c) => c.name())).toContain("expose");
});

test("`update` is a top-level command (self-updates the CLI)", () => {
  const p = buildProgram();
  expect(p.commands.map((c) => c.name())).toContain("update");
});

test("the program exposes a version (drop --version / -v)", () => {
  expect(buildProgram().version()).toBe(VERSION);
});
