// Local backend: stream the uploaded `docker save` archive straight into the k3s node's containerd,
// i.e. the platform now runs the exact `<runtime> exec -i <k3s> ctr ... images import -` step that
// developers used to run by hand. The CLI tags the image `drop.local/<app>:<version>` before saving,
// so the archive carries that ref; after import we VERIFY the node actually holds that exact ref
// (some builders normalize repo tags on save) and a non-:latest `drop.local/*` ref → IfNotPresent
// → the pod uses it without any registry. No imagePullSecret (nothing to authenticate).
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { ImageStore, ImageScope, PushedImage } from "./types.ts";
import { localImageRef } from "./types.ts";

export interface ContainerdConfig {
  runtime: string; // host CLI that can exec into the k3s container: "podman" | "docker"
  container: string; // the container running k3s (e.g. "k3s")
  sock: string; // k3s containerd socket inside that container
  namespace?: string; // containerd namespace k8s uses (default "k8s.io")
}
type SpawnFn = typeof nodeSpawn;

export class ContainerdImageStore implements ImageStore {
  constructor(
    private cfg: ContainerdConfig,
    private spawn: SpawnFn = nodeSpawn,
  ) {}

  private ctr(extra: string[]): string[] {
    return ["exec", "-i", this.cfg.container, "ctr", "-a", this.cfg.sock, "-n", this.cfg.namespace ?? "k8s.io", ...extra];
  }

  async push(scope: ImageScope, version: string, tarball: Readable): Promise<PushedImage> {
    const ref = localImageRef(scope.app, version);
    // `ctr images import` reads a docker/OCI archive from stdin and registers its repo tags.
    await this.run(this.cfg.runtime, this.ctr(["images", "import", "-"]), tarball);
    // Verify the node now holds the EXACT ref the Deployment will reference. If a builder normalized
    // the saved repo tag (e.g. some podman versions), the import "succeeds" but the pod would then
    // ImagePullBackOff against drop.local (no registry) — fail the push loudly instead.
    const listed = await this.capture(this.cfg.runtime, this.ctr(["images", "ls", "-q"]));
    if (!listed.split(/\s+/).includes(ref)) {
      throw new Error(`imported image not found as "${ref}" in containerd (the local builder likely renamed the tag on save); set DROP_BUILDER to match, or rebuild`);
    }
    return { image: ref };
  }

  // Best-effort: untag the app's imported images so the node's containerd store doesn't grow forever.
  // (containerd won't GC a still-tagged image.) Non-fatal — image GC is not tenant-isolating.
  async destroy(_scope: ImageScope): Promise<void> {}

  // Pipe a stream into the child's stdin; reject on spawn error or non-zero exit.
  private run(cmd: string, args: string[], stdin: Readable): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = this.spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      p.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      p.on("error", reject); // e.g. the runtime binary isn't on PATH
      p.on("close", (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`image import (${cmd}) exited ${code}: ${stderr.slice(0, 500)}`)),
      );
      // If the child exits early (e.g. ctr rejects the archive), writing more to its stdin throws
      // EPIPE; without a listener that becomes an uncaught exception that crashes the API process.
      if (p.stdin) p.stdin.on("error", () => {});
      // A client that aborts mid-upload makes `stdin` emit 'error'; tear the child down.
      stdin.on("error", () => p.kill());
      if (p.stdin) stdin.pipe(p.stdin);
    });
  }

  // Run a command and capture stdout (no stdin); reject on non-zero exit.
  private capture(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = this.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr?.on("data", (d: Buffer) => (err += d.toString()));
      p.on("error", reject);
      p.on("close", (code: number | null) => (code === 0 ? resolve(out) : reject(new Error(`ctr images ls (${cmd}) exited ${code}: ${err.slice(0, 300)}`))));
    });
  }
}
