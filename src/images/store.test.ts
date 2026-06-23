import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { ContainerdImageStore } from "./containerd-store.ts";
import { makeImageStore } from "./factory.ts";
import { FakeImageStore } from "./fake.ts";
import { loadConfig } from "../config.ts";
import type { KubeClient } from "../kube/types.ts";

// A spawn shim for the runtime CLI. `push` makes TWO calls: `ctr images import -` (drains stdin)
// then `ctr images ls -q` (emits the listing on stdout so the post-import verification can run).
function fakeRuntime(opts: { importExit?: number; importStderr?: string; lsOut?: string } = {}) {
  const calls: { cmd: string; args: string[]; bytes?: number }[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    const call: { cmd: string; args: string[]; bytes?: number } = { cmd, args };
    calls.push(call);
    const p: any = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    if (args.includes("import")) {
      const stdin = new PassThrough();
      let bytes = 0;
      stdin.on("data", (c: Buffer) => (bytes += c.length));
      stdin.on("finish", () => {
        call.bytes = bytes;
        if (opts.importStderr) p.stderr.write(opts.importStderr);
        setImmediate(() => p.emit("close", opts.importExit ?? 0));
      });
      p.stdin = stdin;
    } else {
      setImmediate(() => {
        if (opts.lsOut !== undefined) p.stdout.write(opts.lsOut);
        p.emit("close", 0);
      });
    }
    return p;
  }) as any;
  return { spawn, calls };
}

const scope = { owner: "a@x.com", app: "myapp", namespace: "drop-t-a" };
const tarball = () => Readable.from([Buffer.from("layerA"), Buffer.from("layerBB")]); // 13 bytes

test("ContainerdImageStore imports the archive, verifies the ref, returns the canonical ref", async () => {
  const rt = fakeRuntime({ lsOut: "ghcr.io/x:1\ndrop.local/myapp:v7\n" });
  const store = new ContainerdImageStore({ runtime: "podman", container: "k3s", sock: "/run/k3s.sock" }, rt.spawn);
  const out = await store.push(scope, "v7", tarball());
  expect(out).toEqual({ image: "drop.local/myapp:v7" });
  expect(rt.calls[0]!.cmd).toBe("podman");
  expect(rt.calls[0]!.args).toEqual(["exec", "-i", "k3s", "ctr", "-a", "/run/k3s.sock", "-n", "k8s.io", "images", "import", "-"]);
  expect(rt.calls[0]!.bytes).toBe(13); // the whole upload streamed through
  expect(rt.calls[1]!.args).toContain("ls"); // the verification call ran
});

test("ContainerdImageStore rejects (with stderr) when ctr import exits non-zero", async () => {
  const rt = fakeRuntime({ importExit: 1, importStderr: "ctr: failed to import" });
  const store = new ContainerdImageStore({ runtime: "docker", container: "k3s", sock: "/s" }, rt.spawn);
  await expect(store.push(scope, "v1", tarball())).rejects.toThrow(/exited 1.*failed to import/);
});

test("ContainerdImageStore rejects when the expected ref isn't present after import (builder renamed it)", async () => {
  const rt = fakeRuntime({ lsOut: "localhost/drop.local/myapp:v7\n" }); // normalized → not the exact ref
  const store = new ContainerdImageStore({ runtime: "podman", container: "k3s", sock: "/s" }, rt.spawn);
  await expect(store.push(scope, "v7", tarball())).rejects.toThrow(/imported image not found as "drop.local\/myapp:v7"/);
});

test("makeImageStore: Noop when compute disabled; containerd vs registry by config", async () => {
  const baseEnv = { DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y" };
  const noop = makeImageStore(loadConfig(baseEnv));
  await expect(noop.push(scope, "v1", tarball())).rejects.toThrow(/compute is not enabled/);

  const kube = {} as KubeClient; // presence is the only signal the factory needs
  expect(makeImageStore(loadConfig(baseEnv), kube)).toBeInstanceOf(ContainerdImageStore);

  expect(() => makeImageStore(loadConfig({ ...baseEnv, DROP_IMAGE_BACKEND: "registry" }), kube)).toThrow(/DROP_IMAGE_REGISTRY/);
  const reg = makeImageStore(loadConfig({ ...baseEnv, DROP_IMAGE_BACKEND: "registry", DROP_IMAGE_REGISTRY: "r.io/apps" }), kube);
  expect(reg.constructor.name).toBe("RegistryImageStore");
});

test("FakeImageStore drains the stream + records the push", async () => {
  const f = new FakeImageStore();
  const out = await f.push(scope, "v1", tarball());
  expect(out.image).toBe("drop.local/myapp:v1");
  expect(f.pushes).toEqual([{ scope, version: "v1", bytes: 13 }]);
});
