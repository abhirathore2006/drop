// Composition root for the ImageStore: pick the backend at deploy time (DROP_IMAGE_BACKEND).
// "containerd" (local k3s) imports into the node's containerd; "registry" (prod) pushes to ECR/etc.
import type { Config } from "../config.ts";
import type { KubeClient } from "../kube/types.ts";
import { ContainerdImageStore } from "./containerd-store.ts";
import { RegistryImageStore } from "./registry-store.ts";
import type { ImageScope, ImageStore } from "./types.ts";

// Used when compute is disabled (no kubeconfig): no apps exist, so the image route 501s before this
// is ever called. Present only to satisfy the required Deps.images.
class NoopImageStore implements ImageStore {
  async push(): Promise<never> {
    throw new Error("compute is not enabled on this instance");
  }
  async destroy(_s: ImageScope): Promise<void> {}
}

export function makeImageStore(cfg: Config, kube?: KubeClient): ImageStore {
  if (!kube) return new NoopImageStore();
  if (cfg.imageBackend === "registry") {
    if (!cfg.imageRegistry) throw new Error("DROP_IMAGE_REGISTRY is required when DROP_IMAGE_BACKEND=registry");
    return new RegistryImageStore({ registry: cfg.imageRegistry });
  }
  return new ContainerdImageStore({
    runtime: cfg.imageRuntime,
    container: cfg.imageK3sContainer,
    sock: cfg.imageContainerdSock,
  });
}
