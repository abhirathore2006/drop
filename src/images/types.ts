// The image-store boundary. The API depends on this port, never on a concrete backend — so the
// same "push an image through Drop" flow works by importing into the local cluster's containerd
// (local k3s) or by pushing to a registry like ECR (prod), chosen at deploy time. The developer's
// CLI builds locally and uploads a `docker save` tarball; the backend makes it pullable by the
// cluster and returns the in-cluster image reference (plus, for registry backends, the name of an
// imagePullSecret the Deployment must reference). The developer never needs registry credentials.
import type { Readable } from "node:stream";

export interface ImageScope {
  owner: string; // canonical (lowercased) owner email
  app: string; // workload name (globally unique in Drop)
  namespace: string; // tenant namespace
}

export interface PushedImage {
  /** The image reference to put in the Deployment's container.image. */
  image: string;
}
// NOTE: the Deployment's imagePullSecret (registry backends) is wired from operator config
// (DROP_IMAGE_REGISTRY_PULL_SECRET) at deploy time, not returned per-push — keep that single source
// of truth rather than threading a redundant value through the push response.

export interface ImageStore {
  /** Ingest a `docker save` image archive (gzip tolerated) for <app>@<version> and make it pullable
   *  by the cluster. `tarball` is consumed exactly once (streamed, never fully buffered). Returns the
   *  in-cluster image reference to deploy. */
  push(scope: ImageScope, version: string, tarball: Readable): Promise<PushedImage>;
  /** Remove an app's image material (best-effort; called on app delete). Safe if absent. */
  destroy(scope: ImageScope): Promise<void>;
}

/** The Drop-canonical local image reference for an app version. A fully-qualified ref (host/path:tag)
 *  so the archive tag and the Deployment image string match EXACTLY — avoiding containerd's
 *  docker.io/library normalization, which otherwise makes "<name>:<tag>" and the imported ref differ.
 *  The `drop.local` host is never resolved: a non-:latest tag → IfNotPresent → the present image is used. */
export const localImageRef = (app: string, version: string) => `drop.local/${app}:${version}`;
