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

// Text file extensions eligible for `env_from` placeholder substitution (site→app edge, B2). Binary
// assets (images, fonts, wasm) are never rewritten — substitution is a textual `${AS}` → value pass.
const SUBST_EXT = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".css", ".json", ".txt", ".xml", ".svg", ".webmanifest"]);

/** Options for packDir. `substitutions` (B2 stack env_from) replaces `${KEY}` in text files at pack
 *  time — the CLI-side half of a site→app edge (the server never rewrites bytes). */
export interface PackOptions {
  substitutions?: Record<string, string>;
}

function extOf(rel: string): string {
  const i = rel.lastIndexOf(".");
  return i < 0 ? "" : rel.slice(i).toLowerCase();
}

/** Apply `${KEY}` → value replacement across a text file's contents (all occurrences). */
function applySubst(text: string, subs: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(subs)) out = out.split("${" + k + "}").join(v);
  return out;
}

/** Gzipped tar of `dir` with relative, slash-separated paths. With `opts.substitutions`, text files
 *  get `${KEY}` placeholders replaced (used by `drop up` to inject a resource's URL into a site). */
export async function packDir(dir: string, opts: PackOptions = {}): Promise<Buffer> {
  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  const subs = opts.substitutions && Object.keys(opts.substitutions).length ? opts.substitutions : undefined;

  const p = pack();
  const out = buffer(p.pipe(createGzip())); // start draining

  for await (const file of walk(dir)) {
    const rel = relative(dir, file).split(sep).join("/");
    let data = await readFile(file);
    if (subs && SUBST_EXT.has(extOf(rel))) data = Buffer.from(applySubst(data.toString("utf8"), subs), "utf8");
    await new Promise<void>((resolve, reject) => {
      p.entry({ name: rel, size: data.length }, data, (err) => (err ? reject(err) : resolve()));
    });
  }
  p.finalize();
  return await out;
}
