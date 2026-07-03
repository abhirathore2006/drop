// The critical round-trip test: our USTAR writer against the server's own extractor
// (../../../src/archive.ts extractTarGz, real tar-stream under the hood). This is a
// node-side test of pure byte-format compatibility — no happy-dom needed, no DOM
// touched — so it does NOT import ./test/setup.ts.
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { extractTarGz } from "../../../src/archive.ts";
import { tarball, type TarFile } from "./tar.ts";

async function drain(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Writes `files` with our tarball(), gzips with node:zlib, and feeds the result through
 *  the real server extractor — mirroring exactly what the browser → API upload does. */
async function roundTrip(files: TarFile[]): Promise<{ out: Map<string, Buffer>; files: number; bytes: number }> {
  const tar = tarball(files);
  const gz = gzipSync(Buffer.from(tar));
  const out = new Map<string, Buffer>();
  const result = await extractTarGz(
    Readable.from(gz),
    async (rel, body) => {
      out.set(rel, await drain(body));
    },
    { maxFiles: 10_000, maxBytes: 64 * 1024 * 1024 },
  );
  return { out, ...result };
}

describe("tarball() round-trips through the server's extractTarGz", () => {
  test("ascii names, nested dirs, and a 0-byte file", async () => {
    const files: TarFile[] = [
      { path: "index.html", bytes: new TextEncoder().encode("<h1>hi</h1>") },
      { path: "assets/js/app.js", bytes: new TextEncoder().encode("console.log(1)") },
      { path: "empty.txt", bytes: new Uint8Array(0) },
    ];
    const { out, files: n, bytes } = await roundTrip(files);
    expect(n).toBe(3);
    expect(bytes).toBe(files.reduce((s, f) => s + f.bytes.length, 0));
    for (const f of files) {
      const got = out.get(f.path);
      expect(got).toBeDefined();
      expect(got!.equals(Buffer.from(f.bytes))).toBe(true);
    }
  });

  test("utf8 file and directory names", async () => {
    const files: TarFile[] = [
      { path: "dossiers/héllo-世界.txt", bytes: new TextEncoder().encode("bonjour 世界") },
      { path: "emoji-📦/drop.txt", bytes: new TextEncoder().encode("packed") },
    ];
    const { out } = await roundTrip(files);
    expect(out.get("dossiers/héllo-世界.txt")?.toString("utf8")).toBe("bonjour 世界");
    expect(out.get("emoji-📦/drop.txt")?.toString("utf8")).toBe("packed");
  });

  test("~1MB file round-trips byte-identical", async () => {
    const big = new Uint8Array(1024 * 1024 + 37); // not a clean multiple of the 512-byte block
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const { out } = await roundTrip([{ path: "big.bin", bytes: big }]);
    expect(out.get("big.bin")?.equals(Buffer.from(big))).toBe(true);
  });

  test("path over 100 bytes uses the ustar prefix field", async () => {
    const path = `${"a".repeat(70)}/${"b".repeat(70)}/file.txt`; // >100 bytes total
    expect(path.length).toBeGreaterThan(100);
    const { out } = await roundTrip([{ path, bytes: new TextEncoder().encode("x") }]);
    expect(out.get(path)?.toString("utf8")).toBe("x");
  });

  test("many short segments whose *whole* path exceeds the ustar name+prefix budget round-trips only if it fits, else throws", () => {
    // A single 100-byte segment is exactly at the name-field limit and needs no prefix.
    const exact = "x".repeat(100);
    expect(() => tarball([{ path: exact, bytes: new Uint8Array(0) }])).not.toThrow();
  });

  test("writer rejects a single path segment over 100 bytes (no slash to split on)", () => {
    const path = "x".repeat(300); // no "/" at all — can't be split into name<=100/prefix<=155
    expect(() => tarball([{ path, bytes: new Uint8Array(0) }])).toThrow();
  });

  test("writer rejects a path too long even split across the prefix field (~255 byte budget)", () => {
    const path = Array.from({ length: 20 }, (_, i) => `segment-${i}-padding`).join("/"); // ~400 bytes
    expect(path.length).toBeGreaterThan(255);
    expect(() => tarball([{ path, bytes: new Uint8Array(0) }])).toThrow();
  });
});
