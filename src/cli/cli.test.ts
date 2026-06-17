import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { Readable } from "node:stream";
import { saveSession, loadSession } from "./session.ts";
import { loadConfig, saveConfig, resolveApiBase } from "./config.ts";
import { packDir } from "./pack.ts";
import { devLoginToken } from "./login.ts";

test("session save/load round trip", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "drop-")), "session.json");
  await saveSession(path, { apiBase: "http://localhost:8080", token: "alice:alice@example.com" });
  const s = await loadSession(path);
  expect(s.token).toBe("alice:alice@example.com");
  expect(s.apiBase).toBe("http://localhost:8080");
});

test("devLoginToken builds sub:email", () => {
  expect(devLoginToken("alice", "alice@example.com")).toBe("alice:alice@example.com");
});

test("config persists the API URL; resolveApiBase precedence flag > env > config > default", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "drop-cfg-")), "config.json");
  const saved = process.env.DROP_API;
  delete process.env.DROP_API;
  try {
    expect(await loadConfig(path)).toEqual({});
    await saveConfig({ apiBase: "http://saved:1" }, path);
    expect((await loadConfig(path)).apiBase).toBe("http://saved:1");

    expect(await resolveApiBase({}, path)).toBe("http://saved:1"); // from config
    expect(await resolveApiBase({ api: "http://flag:2/" }, path)).toBe("http://flag:2"); // flag wins (trailing / trimmed)
    process.env.DROP_API = "http://env:3";
    expect(await resolveApiBase({}, path)).toBe("http://env:3"); // env over config
    delete process.env.DROP_API;
    expect(await resolveApiBase({}, join(tmpdir(), "drop-nope", "missing.json"))).toBe("https://api.drop.example.com"); // default
  } finally {
    if (saved === undefined) delete process.env.DROP_API;
    else process.env.DROP_API = saved;
  }
});

test("packDir produces relative slash paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drop-pack-"));
  writeFileSync(join(dir, "index.html"), "<html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "x");

  const tgz = await packDir(dir);
  const seen: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const ex = extract();
    ex.on("entry", (h, s, next) => {
      seen.push(h.name);
      s.on("end", next);
      s.resume();
    });
    ex.on("finish", () => resolve());
    ex.on("error", reject);
    Readable.from(tgz).pipe(createGunzip()).pipe(ex);
  });
  expect(seen.sort()).toEqual(["assets/app.js", "index.html"]);
});
