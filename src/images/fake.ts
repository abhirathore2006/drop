// In-memory ImageStore for tests: drains the tarball (so byte accounting + backpressure are
// exercised) and records each push. Returns the same canonical local ref a real backend would.
import type { Readable } from "node:stream";
import type { ImageStore, ImageScope, PushedImage } from "./types.ts";
import { localImageRef } from "./types.ts";

export class FakeImageStore implements ImageStore {
  pushes: { scope: ImageScope; version: string; bytes: number }[] = [];
  destroyed: string[] = [];
  /** Optional injected failure to exercise error paths. */
  failNext?: Error;

  async push(scope: ImageScope, version: string, tarball: Readable): Promise<PushedImage> {
    let bytes = 0;
    for await (const chunk of tarball) bytes += (chunk as Buffer).length; // drain (exactly once)
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    this.pushes.push({ scope, version, bytes });
    return { image: localImageRef(scope.app, version) };
  }

  async destroy(scope: ImageScope): Promise<void> {
    this.destroyed.push(scope.app);
  }
}
