import { test, expect } from "bun:test";
import { createConfigClient, ConfigError, type FetchLike } from "./index.ts";

// A scriptable fetch: each call returns the NEXT queued response and records the request (url + headers),
// so tests can assert the If-None-Match / Authorization round-trip. pollMs:0 disables the background timer
// so every poll is a deterministic, manual `refresh()`.
function scriptedFetch(responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  return { fetch, calls };
}

test("createConfigClient: throws without a URL", () => {
  expect(() => createConfigClient({ pollMs: 0 })).toThrow(ConfigError);
});

test("initial refresh loads the map + version and fires onChange once; getAll is a copy", async () => {
  const { fetch } = scriptedFetch([{ status: 200, body: { config: { FEATURE_X: "on", THEME: "dark" }, version: 3 } }]);
  const client = createConfigClient({ url: "https://api/x/config", pollMs: 0, fetch });
  const changes: { map: Record<string, string>; version: number }[] = [];
  client.onChange((map, version) => changes.push({ map, version }));

  await client.refresh();
  expect(client.get("FEATURE_X")).toBe("on");
  expect(client.getAll()).toEqual({ FEATURE_X: "on", THEME: "dark" });
  expect(client.version).toBe(3);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toEqual({ map: { FEATURE_X: "on", THEME: "dark" }, version: 3 });

  // getAll returns a copy — mutating it doesn't leak into the client.
  const copy = client.getAll();
  copy.FEATURE_X = "tampered";
  expect(client.get("FEATURE_X")).toBe("on");
});

test("a 304 (unchanged) fires NO onChange and keeps the cached map; If-None-Match is sent after load", async () => {
  const { fetch, calls } = scriptedFetch([
    { status: 200, body: { config: { A: "1" }, version: 1 } },
    { status: 304 },
  ]);
  const client = createConfigClient({ url: "https://api/x/config", token: "drop_st_abc", pollMs: 0, fetch });
  let fires = 0;
  client.onChange(() => fires++);

  await client.refresh(); // 200 → load
  expect(fires).toBe(1);
  // first request carries the token but NO If-None-Match (nothing loaded yet)
  expect(calls[0]!.headers["authorization"]).toBe("Bearer drop_st_abc");
  expect(calls[0]!.headers["if-none-match"]).toBeUndefined();

  await client.refresh(); // 304 → unchanged
  expect(fires).toBe(1); // no additional onChange
  expect(client.getAll()).toEqual({ A: "1" }); // map preserved
  expect(client.version).toBe(1);
  // the second request echoes the ETag back for the conditional GET
  expect(calls[1]!.headers["if-none-match"]).toBe('W/"1"');
});

test("a version advance fires onChange with the new map/version", async () => {
  const { fetch } = scriptedFetch([
    { status: 200, body: { config: { A: "1" }, version: 1 } },
    { status: 200, body: { config: { A: "1", B: "2" }, version: 2 } },
  ]);
  const client = createConfigClient({ url: "https://api/x/config", pollMs: 0, fetch });
  const versions: number[] = [];
  client.onChange((_map, v) => versions.push(v));

  await client.refresh();
  await client.refresh();
  expect(versions).toEqual([1, 2]);
  expect(client.getAll()).toEqual({ A: "1", B: "2" });

  // unsubscribe stops further notifications
  const off = client.onChange(() => versions.push(999));
  off();
});

test("a 200 that repeats the SAME version is treated as unchanged (no onChange)", async () => {
  const { fetch } = scriptedFetch([
    { status: 200, body: { config: { A: "1" }, version: 5 } },
    { status: 200, body: { config: { A: "1" }, version: 5 } },
  ]);
  const client = createConfigClient({ url: "https://api/x/config", pollMs: 0, fetch });
  let fires = 0;
  client.onChange(() => fires++);
  await client.refresh();
  await client.refresh();
  expect(fires).toBe(1);
});

test("a failed poll routes to onError, keeps the last-known map, and never throws", async () => {
  const { fetch } = scriptedFetch([
    { status: 200, body: { config: { A: "1" }, version: 1 } },
    { status: 500 },
  ]);
  const errors: Error[] = [];
  const client = createConfigClient({ url: "https://api/x/config", pollMs: 0, fetch, onError: (e) => errors.push(e) });
  await client.refresh();
  await client.refresh(); // 500
  expect(errors).toHaveLength(1);
  expect(client.getAll()).toEqual({ A: "1" }); // preserved across the failed poll
});
