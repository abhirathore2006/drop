// Pack dropped files into a gzip USTAR tarball and upload them to the versions endpoint —
// the exact same endpoint the CLI's `drop publish` posts to (src/cli/client.ts `publish()`
// → POST /v1/sites/:name/versions, src/api/server.ts). That endpoint auto-claims the site
// on first publish (creates it in the caller's personal org if the name doesn't exist
// yet), so there is no separate "create site" call to mirror: publishing a not-yet-
// -existing name IS claiming it. A drop.yaml inside the dropped folder travels as an
// ordinary file in the tarball, exactly like the CLI's packDir — the server parses it
// from the upload stream (src/api/server.ts captures the `drop.yaml` entry instead of
// blobbing it, then calls parseDropYaml on it).
//
// fflate is dynamically imported here — inside the publish action, not at module scope —
// so its ~8 kB gzip codec ships as its own lazy chunk instead of bloating the initial
// bundle (verified by build.mjs producing a separate assets/fflate-*.js chunk).
import { tarball, type TarFile } from "./tar.ts";
import type { DroppedFile } from "./dropFiles.ts";

export interface PublishResult {
  url: string;
  version?: string;
}

/** Pack + gzip + upload. `onProgress` receives a 0..1 fraction driven by the upload's
 *  `progress` event (XHR, not fetch — this is the one place XHR beats fetch: it's the
 *  only API that reports upload progress without hand-rolling a chunked ReadableStream). */
export async function publishFiles(name: string, files: DroppedFile[], onProgress?: (fraction: number) => void): Promise<PublishResult> {
  const tarFiles: TarFile[] = files.map((f) => ({ path: f.path, bytes: f.bytes }));
  const tar = tarball(tarFiles);
  const { gzipSync } = await import("fflate");
  const gz = gzipSync(tar);
  return uploadVersion(name, gz, onProgress);
}

function uploadVersion(name: string, body: Uint8Array, onProgress?: (fraction: number) => void): Promise<PublishResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/v1/sites/${encodeURIComponent(name)}/versions`);
    xhr.setRequestHeader("content-type", "application/gzip");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let json: unknown = {};
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        /* non-JSON body — fall through with the bare status */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(json as PublishResult);
      } else {
        const msg = (json as { error?: string }).error ?? `publish failed: HTTP ${xhr.status}`;
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("network error during upload"));
    // A plain ArrayBuffer (rather than the Uint8Array view) sidesteps TS 5.7+'s generic
    // Uint8Array<ArrayBufferLike> not lining up with XMLHttpRequestBodyInit's ArrayBufferView.
    xhr.send(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
  });
}
