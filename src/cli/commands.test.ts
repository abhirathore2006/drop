import { test, expect } from "bun:test";
import { buildProgram, resolveSince } from "./commands.ts";
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

test("auth (K1) is a command group with create/ls/config/rotate-keys + a users subgroup", () => {
  const p = buildProgram();
  const top = p.commands.map((c) => c.name());
  expect(top).toContain("auth");
  const auth = p.commands.find((c) => c.name() === "auth")!;
  const subs = auth.commands.map((c) => c.name());
  for (const s of ["create", "ls", "config", "rotate-keys", "users"]) expect(subs).toContain(s);
  // create carries --db / --with-db / --org / --signup
  const create = auth.commands.find((c) => c.name() === "create")!;
  for (const o of ["--db", "--with-db", "--org", "--signup"]) expect(create.options.some((x) => x.long === o)).toBe(true);
  // users is a subgroup with ls/create/rm
  const users = auth.commands.find((c) => c.name() === "users")!;
  const userSubs = users.commands.map((c) => c.name());
  for (const s of ["ls", "create", "rm"]) expect(userSubs).toContain(s);
});

test("`update` is a top-level command (self-updates the CLI)", () => {
  const p = buildProgram();
  expect(p.commands.map((c) => c.name())).toContain("update");
});

test("the program exposes a version (drop --version / -v)", () => {
  expect(buildProgram().version()).toBe(VERSION);
});

test("publish carries --preview/--expire-days (E1); `preview` is a group with ls/rm", () => {
  const p = buildProgram();
  const publish = p.commands.find((c) => c.name() === "publish")!;
  expect(publish.options.some((o) => o.long === "--preview")).toBe(true);
  expect(publish.options.some((o) => o.long === "--expire-days")).toBe(true);

  const top = p.commands.map((c) => c.name());
  expect(top).toContain("preview");
  const preview = p.commands.find((c) => c.name() === "preview")!;
  const subs = preview.commands.map((c) => c.name());
  expect(subs).toContain("ls");
  expect(subs).toContain("rm");
  // ls/rm identify a globally-unique resource name → no --org (mirrors share/rm/rollback etc.)
  expect(preview.commands.find((c) => c.name() === "ls")!.options.some((o) => o.long === "--org")).toBe(false);
});

test("(L4) `config` carries the app runtime-config subcommands set/ls/rm alongside set-api/show", () => {
  const p = buildProgram();
  const config = p.commands.find((c) => c.name() === "config")!;
  const subs = config.commands.map((c) => c.name());
  for (const s of ["set-api", "show", "set", "ls", "rm"]) expect(subs).toContain(s);
});

test("(L4) `config set` refuses credential-looking keys/values client-side (never hits the network)", async () => {
  // secret-y key name → rejected before any client() call
  await expect(buildProgram().parseAsync(["node", "drop", "config", "set", "myapp", "API_KEY=whatever"])).rejects.toThrow(/secret/i);
  // opaque high-entropy value under a benign key → rejected too
  await expect(buildProgram().parseAsync(["node", "drop", "config", "set", "myapp", "BLOB=9aF3kQ2mZ7pL1xR8vT4wYbN6cD0eG5hJ7tWq"])).rejects.toThrow(/secret/i);
  // a malformed pair (no '=') is a clear error
  await expect(buildProgram().parseAsync(["node", "drop", "config", "set", "myapp", "novalue"])).rejects.toThrow(/KEY=value/);
});

test("(G4) `drop logs` carries the historical-search flags alongside the live -f follow", () => {
  const p = buildProgram();
  const logs = p.commands.find((c) => c.name() === "logs")!;
  const longs = logs.options.map((o) => o.long);
  for (const f of ["--since", "--until", "--grep", "--regex", "--ignore-case", "--follow", "--release"]) expect(longs).toContain(f);
});

test("(G4) resolveSince: a duration window is measured back from now; an ISO timestamp is absolute", () => {
  const now = Date.parse("2026-07-04T12:00:00.000Z");
  expect(resolveSince("2h", now)).toBe("2026-07-04T10:00:00.000Z");
  expect(resolveSince("7d", now)).toBe("2026-06-27T12:00:00.000Z");
  expect(resolveSince("2026-07-01T00:00:00.000Z", now)).toBe("2026-07-01T00:00:00.000Z");
  expect(() => resolveSince("last tuesday", now)).toThrow(/invalid --since/);
});
