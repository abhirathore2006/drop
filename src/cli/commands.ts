import { Command } from "commander";
import { rm } from "node:fs/promises";
import { defaultSessionPath, loadSession, saveSession } from "./session.ts";
import { Client } from "./client.ts";
import { packDir } from "./pack.ts";
import { devLoginToken, serverLogin } from "./login.ts";

function apiBase(opts: { api?: string }): string {
  return opts.api ?? process.env.DROP_API ?? "https://api.drop.company.com";
}

async function client(): Promise<Client> {
  try {
    return new Client(await loadSession(defaultSessionPath()));
  } catch {
    console.error("not logged in — run `drop login` (or `drop dev-login`) first");
    process.exit(1);
  }
}

const show = (v: unknown) => console.log(JSON.stringify(v, null, 2));

export function buildProgram(): Command {
  const program = new Command();
  program.name("drop").description("Publish static sites to *.drop.company.com");
  program.option("--api <url>", "control plane base URL");

  program
    .command("login")
    .description("Sign in with Google (via the Drop server)")
    .action(async () => {
      const base = apiBase(program.opts());
      const token = await serverLogin(base);
      await saveSession(defaultSessionPath(), { apiBase: base, token });
      console.log("✓ logged in");
    });

  program
    .command("dev-login <sub> <email>")
    .description("Local-only login (requires DROP_DEV_AUTH=1 on the API)")
    .action(async (sub: string, email: string) => {
      await saveSession(defaultSessionPath(), { apiBase: apiBase(program.opts()), token: devLoginToken(sub, email) });
      console.log("✓ dev session saved");
    });

  program
    .command("logout")
    .description("Clear the saved session")
    .action(async () => {
      await rm(defaultSessionPath(), { force: true });
      console.log("✓ logged out");
    });

  program
    .command("publish <dir> <name>")
    .description("Publish a built folder to <name>.drop.company.com")
    .action(async (dir: string, name: string) => {
      console.log(`  ▸ packing ${dir}`);
      const tarball = await packDir(dir);
      console.log("  ▸ dropping…");
      const res = await (await client()).publish(name, tarball);
      console.log(`  ✓ live at ${res.url}`);
    });

  program
    .command("rollback <name>")
    .description("Roll back to the previous (or --to) version")
    .option("--to <version>", "specific version id")
    .action(async (name: string, opts: { to?: string }) => {
      const res = await (await client()).rollback(name, opts.to ?? "");
      console.log(`  ✓ now serving ${res.version} at ${res.url}`);
    });

  program.command("info <name>").description("Show site metadata").action(async (name: string) => show(await (await client()).info(name)));
  program.command("members <name>").description("Show owner + collaborators").action(async (name: string) => show(await (await client()).info(name)));
  program.command("ls").description("List your sites").action(async () => show(await (await client()).list()));
  program.command("rm <name>").description("Unpublish a site").action(async (name: string) => show(await (await client()).remove(name)));
  program.command("share <name> <email>").description("Add a collaborator").action(async (name: string, email: string) => show(await (await client()).share(name, email)));
  program.command("unshare <name> <email>").description("Remove a collaborator").action(async (name: string, email: string) => show(await (await client()).unshare(name, email)));
  program.command("transfer <name> <email>").description("Transfer ownership").action(async (name: string, email: string) => show(await (await client()).transfer(name, email)));

  return program;
}
