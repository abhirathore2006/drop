// Prod backend: push the uploaded `docker save` archive to a real registry (e.g. ECR) so EKS nodes
// pull it normally. skopeo copies a docker-archive → a registry ref without needing a Docker daemon
// in the API pod. Auth to the registry is the cluster's concern: either node IRSA (ECR) or a
// pre-provisioned imagePullSecret in the tenant namespace, whose name the deploy reads from operator
// config (DROP_IMAGE_REGISTRY_PULL_SECRET). Verified against a real/emulated registry separately;
// local dev uses ContainerdImageStore.
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { ImageStore, ImageScope, PushedImage } from "./types.ts";

export interface RegistryConfig {
  registry: string; // host/repo prefix, e.g. <acct>.dkr.ecr.<region>.amazonaws.com/drop-apps
  skopeo?: string; // skopeo binary (default "skopeo")
}
type SpawnFn = typeof nodeSpawn;

export class RegistryImageStore implements ImageStore {
  constructor(
    private cfg: RegistryConfig,
    private spawn: SpawnFn = nodeSpawn,
  ) {}

  async push(scope: ImageScope, version: string, tarball: Readable): Promise<PushedImage> {
    // The app name is globally unique in Drop, so <registry>/<app>:<version> is a safe per-app path.
    const ref = `${this.cfg.registry.replace(/\/+$/, "")}/${scope.app}:${version}`;
    const dir = await mkdtemp(join(tmpdir(), "drop-img-"));
    const archive = join(dir, "image.tar");
    try {
      await pipeline(tarball, createWriteStream(archive)); // stream to disk; skopeo can't read a pipe archive
      await this.run(this.cfg.skopeo ?? "skopeo", ["copy", `docker-archive:${archive}`, `docker://${ref}`]);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return { image: ref };
  }

  async destroy(_scope: ImageScope): Promise<void> {}

  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = this.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      p.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      p.on("error", reject);
      p.on("close", (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`registry push (${cmd}) exited ${code}: ${stderr.slice(0, 500)}`)),
      );
    });
  }
}
