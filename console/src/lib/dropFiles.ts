// Folder ingestion for the drop zone: turns a browser drag-and-drop (DataTransferItemList,
// via the webkitGetAsEntry entry API) or an <input webkitdirectory> picker's FileList into
// a flat list of relative-path + bytes — the shape lib/tar.ts's tarball() consumes.

export interface DroppedFile {
  /** "/"-separated path, relative to the dropped folder's own root (matches how
   *  `drop publish ./dist` packs — paths never include the folder's own name). */
  path: string;
  bytes: Uint8Array;
}

// Junk that should never ship: macOS Finder metadata, VCS internals, and node_modules —
// the last because it's easy to drag an entire project instead of its build output, and
// including it would blow the server's upload-size cap for zero benefit.
const SKIP_SEGMENTS = new Set([".git", "node_modules"]);

function isJunk(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.some((p) => SKIP_SEGMENTS.has(p))) return true;
  if (parts[parts.length - 1] === ".DS_Store") return true;
  return false;
}

async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, base: string, out: DroppedFile[]): Promise<void> {
  const rel = base ? `${base}/${entry.name}` : entry.name;
  if (isJunk(rel)) return;
  if (entry.isFile) {
    const file = await readFile(entry as FileSystemFileEntry);
    out.push({ path: rel, bytes: await fileToBytes(file) });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries() only returns a batch at a time (spec-mandated); keep calling until empty.
    for (;;) {
      const batch = await readEntries(reader);
      if (!batch.length) break;
      for (const child of batch) await walk(child, rel, out);
    }
  }
}

/** Traverse a drop event's `DataTransferItemList` into a flat file list. Each top-level
 *  dropped entry is unwrapped if it's a directory — tar paths are relative to ITS
 *  contents ("index.html", not "dist/index.html"), matching `drop publish ./dist`. */
export async function readDataTransfer(items: DataTransferItemList): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  for (const root of roots) {
    if (root.isDirectory) {
      const reader = (root as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await readEntries(reader);
        if (!batch.length) break;
        for (const child of batch) await walk(child, "", out);
      }
    } else {
      await walk(root, "", out);
    }
  }
  return out;
}

/** Read an `<input webkitdirectory>` FileList into the same shape. Each file's
 *  `webkitRelativePath` includes the picked folder's own name as its first segment
 *  ("myfolder/src/index.html") — stripped so paths match the drag-and-drop shape. */
export async function readFileList(files: FileList): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  for (const file of Array.from(files)) {
    const full = file.webkitRelativePath || file.name;
    const slash = full.indexOf("/");
    const rel = slash === -1 ? full : full.slice(slash + 1);
    if (!rel || isJunk(rel)) continue;
    out.push({ path: rel, bytes: await fileToBytes(file) });
  }
  return out;
}
