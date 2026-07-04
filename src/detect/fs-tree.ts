// The real-filesystem `FileTree` adapter (F1) — the only IO-touching piece of `drop detect`. Kept
// separate from detect.ts so the core stays pure/table-testable; this file is exercised by the
// REAL-FS fixture suite (detect.test.ts) and by the CLI/MCP callers.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileTree, FileTreeEntry } from "./detect.ts";

/** A FileTree rooted at `root` on the real filesystem. `list`/`read` never throw — a missing
 *  directory/file is simply absent (matches the FileTree contract). */
export function createFsFileTree(root: string): FileTree {
  return {
    async list(dir: string): Promise<FileTreeEntry[]> {
      try {
        const entries = await readdir(join(root, dir), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      } catch {
        return [];
      }
    },
    async read(path: string): Promise<string | undefined> {
      try {
        return await readFile(join(root, path), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
