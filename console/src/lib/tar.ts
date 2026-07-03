// Pure USTAR tarball writer — no dependencies.
//
// Byte-for-byte mirrors the header layout `tar-stream` (the server's extractor,
// ../../../src/archive.ts → extractTarGz) reads: same field offsets/widths, same octal
// encoding (n digits + a trailing space, leaving the field's last byte(s) zero — the
// delimiter tar-stream's decoder scans for), same long-path handling (front-to-back
// segment cut into the `prefix` field). console/src/lib/tar.test.ts round-trips this
// writer through the real server-side extractor to prove the two agree.
//
// Only regular-file entries are emitted — extractTarGz skips anything that isn't
// `header.type === "file"` anyway, so directory headers would be dead weight.

const BLOCK = 512;
const enc = new TextEncoder();

export interface TarFile {
  /** "/"-separated path, relative to the archive root. */
  path: string;
  bytes: Uint8Array;
}

function byteLen(s: string): number {
  return enc.encode(s).length;
}

function writeBytes(buf: Uint8Array, offset: number, s: string): void {
  buf.set(enc.encode(s), offset);
}

/** `n`-digit octal field + a trailing space (matches tar-stream's `encodeOct`). Throws if
 *  the value doesn't fit — callers size `n` generously enough that real inputs never hit this. */
function octal(value: number, digits: number): string {
  const s = Math.trunc(value).toString(8);
  if (s.length > digits) throw new Error(`value ${value} does not fit in ${digits} octal digits`);
  return "0".repeat(digits - s.length) + s + " ";
}

// Sum every header byte except the checksum field itself (bytes 148..155), which is
// treated as 8 ASCII spaces while computing — identical to tar-stream's `cksum`.
function checksum(buf: Uint8Array): number {
  let sum = 8 * 32;
  for (let i = 0; i < 148; i++) sum += buf[i]!;
  for (let i = 156; i < BLOCK; i++) sum += buf[i]!;
  return sum;
}

/** Split `path` into USTAR name (<=100 bytes) + prefix (<=155 bytes) fields, cutting
 *  whole `/`-separated segments off the front into the prefix until the remainder fits —
 *  the same algorithm tar-stream's encoder uses. Throws a clear error if no split makes
 *  it fit (a single segment over 100 bytes, or the whole path too long even split). */
function splitPath(path: string): { name: string; prefix: string } {
  if (byteLen(path) <= 100) return { name: path, prefix: "" };
  let name = path;
  let prefix = "";
  while (byteLen(name) > 100) {
    const i = name.indexOf("/");
    if (i === -1) {
      throw new Error(
        `path "${path}" has a segment longer than 100 bytes — ustar tar headers can't represent it`,
      );
    }
    prefix = prefix ? `${prefix}/${name.slice(0, i)}` : name.slice(0, i);
    name = name.slice(i + 1);
  }
  if (byteLen(prefix) > 155) {
    throw new Error(
      `path "${path}" is too long for a ustar header (name/prefix fields cap combined length at ~255 bytes)`,
    );
  }
  return { name, prefix };
}

function header(path: string, size: number, mtimeSec: number): Uint8Array {
  const buf = new Uint8Array(BLOCK); // zero-filled
  const { name, prefix } = splitPath(path);

  writeBytes(buf, 0, name); // name          [0, 100)
  writeBytes(buf, 100, octal(0o644, 6)); // mode          [100, 108)
  writeBytes(buf, 108, octal(0, 6)); // uid           [108, 116)
  writeBytes(buf, 116, octal(0, 6)); // gid           [116, 124)
  writeBytes(buf, 124, octal(size, 11)); // size          [124, 136)
  writeBytes(buf, 136, octal(mtimeSec, 11)); // mtime         [136, 148)
  buf[156] = 0x30; // typeflag '0' — regular file
  writeBytes(buf, 257, "ustar\0"); // magic         [257, 263)
  writeBytes(buf, 263, "00"); // version       [263, 265)
  writeBytes(buf, 329, octal(0, 6)); // devmajor      [329, 337)
  writeBytes(buf, 337, octal(0, 6)); // devminor      [337, 345)
  if (prefix) writeBytes(buf, 345, prefix); // prefix        [345, 500)

  writeBytes(buf, 148, octal(checksum(buf), 6)); // chksum [148, 156) — computed last
  return buf;
}

/** Build a gzip-free USTAR tarball from a flat file list. Caller gzips the result
 *  (fflate, lazy-loaded — see lib/publish.ts) before uploading. */
export function tarball(files: TarFile[]): Uint8Array {
  const mtimeSec = Math.floor(Date.now() / 1000);
  const parts: Uint8Array[] = [];
  let total = 0;

  for (const f of files) {
    if (byteLen(f.path) === 0) throw new Error("empty path in tarball()");
    const h = header(f.path, f.bytes.length, mtimeSec);
    parts.push(h, f.bytes);
    total += h.length + f.bytes.length;
    const pad = (BLOCK - (f.bytes.length % BLOCK)) % BLOCK;
    if (pad) {
      parts.push(new Uint8Array(pad));
      total += pad;
    }
  }
  parts.push(new Uint8Array(BLOCK * 2)); // two zero blocks terminate the archive
  total += BLOCK * 2;

  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
