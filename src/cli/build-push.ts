// `drop push` / `drop deploy --build`: build the app image locally, then stream a `docker save`
// tarball THROUGH Drop (PUT /v1/apps/:name/image). The image lands wherever the cluster can pull it
// (local containerd / prod registry) — the developer needs no registry credentials. We tag the image
// `drop.local/<app>:<tag>` and declare the same `<tag>` to the API so the imported ref and the
// Deployment's image string match exactly. A fresh tag per build makes a redeploy roll the pods.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Client } from "./client.ts";

export interface BuildPushResult {
  image: string; // the in-cluster image ref the API recorded (put this in the Deployment)
  tag: string;
}

export interface BuildPushOpts {
  org?: string;
  dockerfile?: string; // custom Dockerfile path (e.g. Dockerfile.prod); default is <dir>/Dockerfile
}

/** The local container CLI used to build/save. Most dev machines have `docker`; override for podman. */
const builder = () => process.env.DROP_BUILDER || "docker";

/** Pure: the `build` argv. `-f <dockerfile>` (when given) before the context dir, matching docker/podman. */
export function buildArgs(ref: string, dir: string, dockerfile?: string): string[] {
  const args = ["build", "-t", ref];
  if (dockerfile) args.push("-f", dockerfile);
  args.push(dir);
  return args;
}

export async function buildAndPushImage(
  client: Client,
  dir: string,
  name: string,
  opts: BuildPushOpts = {},
): Promise<BuildPushResult> {
  const b = builder();
  const tag = `b${Date.now().toString(36)}`; // unique-ish, DNS/tag-safe
  const ref = `drop.local/${name}:${tag}`;

  // The Dockerfile path is resolved relative to your CWD (docker/podman `-f` semantics).
  if (opts.dockerfile && !existsSync(opts.dockerfile)) {
    throw new Error(`Dockerfile not found: ${opts.dockerfile} (the -f/--dockerfile path is relative to your current directory)`);
  }

  const args = buildArgs(ref, dir, opts.dockerfile);
  console.log(`  ▸ building ${ref}  (${b} ${args.join(" ")})…`);
  await run(b, args, "inherit"); // stream build logs to the user

  console.log(`  ▸ pushing image through Drop…`);
  const saver = spawn(b, ["save", ref], { stdio: ["ignore", "pipe", "pipe"] });
  let saveErr = "";
  saver.stderr.on("data", (d: Buffer) => (saveErr += d.toString()));
  const saved = new Promise<void>((resolve, reject) => {
    saver.on("error", reject);
    saver.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${b} save exited ${code}: ${saveErr.slice(0, 300)}`))));
  });

  try {
    const res = (await client.pushImage(name, saver.stdout!, tag, opts.org)) as { image: string }; // consumes the save stream
    await saved; // surface a non-zero `save` even if the upload succeeded on a truncated stream
    return { image: res.image, tag };
  } catch (e) {
    saver.kill(); // upload failed first → don't leave a zombie `save`
    saved.catch(() => {}); // and don't let its close-rejection surface as unhandled
    throw e;
  }
}

function run(cmd: string, args: string[], stdio: "inherit" | "pipe"): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"] });
    let err = "";
    if (stdio === "pipe") p.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`${cmd} not found or failed to start (${e.message}); set DROP_BUILDER to your container CLI`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}${err ? `: ${err.slice(0, 300)}` : ""}`))));
  });
}
