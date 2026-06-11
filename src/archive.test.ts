import { test, expect } from "bun:test";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { extractTarGz } from "./archive.ts";

function makeTarGz(files: Record<string, string>): Readable {
  const p = pack();
  for (const [name, content] of Object.entries(files)) p.entry({ name }, content);
  p.finalize();
  return p.pipe(createGzip());
}

async function drain(s: Readable): Promise<void> {
  for await (const _ of s) {
    /* consume */
  }
}

test("happy path counts files + bytes and maps content types", async () => {
  const seen: Record<string, string> = {};
  const r = await extractTarGz(
    makeTarGz({ "index.html": "<html>", "assets/app.js": "x()" }),
    async (path, body, _size, ct) => {
      seen[path] = ct;
      await drain(body);
    },
    { maxFiles: 10, maxBytes: 1 << 20 },
  );
  expect(r.files).toBe(2);
  expect(r.bytes).toBeGreaterThan(0);
  expect(seen["index.html"]).toBe("text/html");
  expect(seen["assets/app.js"]).toBe("application/javascript");
});

test("rejects path traversal", async () => {
  for (const bad of ["../evil", "/etc/passwd", "a/../../b"]) {
    await expect(
      extractTarGz(makeTarGz({ [bad]: "x" }), async (_p, body) => drain(body), {
        maxFiles: 10,
        maxBytes: 1 << 20,
      }),
    ).rejects.toThrow();
  }
});

test("enforces file-count limit", async () => {
  await expect(
    extractTarGz(makeTarGz({ a: "1", b: "2", c: "3" }), async (_p, body) => drain(body), {
      maxFiles: 2,
      maxBytes: 1 << 20,
    }),
  ).rejects.toThrow();
});
