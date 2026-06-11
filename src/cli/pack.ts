import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** Gzipped tar of `dir` with relative, slash-separated paths. */
export async function packDir(dir: string): Promise<Buffer> {
  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);

  const p = pack();
  const out = buffer(p.pipe(createGzip())); // start draining

  for await (const file of walk(dir)) {
    const rel = relative(dir, file).split(sep).join("/");
    const data = await readFile(file);
    await new Promise<void>((resolve, reject) => {
      p.entry({ name: rel, size: data.length }, data, (err) => (err ? reject(err) : resolve()));
    });
  }
  p.finalize();
  return await out;
}
