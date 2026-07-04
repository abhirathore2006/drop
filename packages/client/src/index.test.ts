import { test, expect } from "bun:test";
import { createClient, DropApiError, type FetchLike } from "./index.ts";

/** A scriptable fetch that records requests and returns a canned JSON body. */
function mockFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; init: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  return { fetch, calls };
}

test("a typed GET method hits the right URL + headers and returns the parsed, typed body", async () => {
  const { fetch, calls } = mockFetch({ email: "a@b.c", admin: false, unresolvedEvents: 2 });
  const c = createClient({ baseUrl: "https://api.test/", fetch, headers: () => ({ authorization: "Bearer tok" }) });
  const me = await c.getMe();
  // typed access — this file would fail to compile if the generated shape drifted
  expect(me.email).toBe("a@b.c");
  expect(me.unresolvedEvents).toBe(2);
  expect(calls[0]!.url).toBe("https://api.test/v1/me"); // trailing slash on baseUrl normalised
  expect(calls[0]!.init.headers.authorization).toBe("Bearer tok");
  expect(calls[0]!.init.method).toBe("GET");
});

test("path params are encoded and query strings are built", async () => {
  const { fetch, calls } = mockFetch({ sites: [] });
  const c = createClient({ baseUrl: "https://api.test", fetch });
  await c.listSites({ org: "acme corp" });
  expect(calls[0]!.url).toBe("https://api.test/v1/sites?org=acme+corp");

  const { fetch: f2, calls: c2 } = mockFetch({ url: "u", version: "v1", files: 1, bytes: 3 });
  const client2 = createClient({ baseUrl: "https://api.test", fetch: f2 });
  const bytes = new Uint8Array([1, 2, 3]);
  const r = await client2.publishSiteVersion({ name: "my site" }, bytes, { preview: "pr", expire_days: "7" });
  expect(r.version).toBe("v1");
  expect(c2[0]!.url).toBe("https://api.test/v1/sites/my%20site/versions?preview=pr&expire_days=7");
  expect(c2[0]!.init.headers["content-type"]).toBe("application/gzip");
  expect(c2[0]!.init.body).toBe(bytes);
});

test("a non-2xx response throws DropApiError carrying the server error message + status", async () => {
  const { fetch } = mockFetch({ error: "no such site" }, false, 404);
  const c = createClient({ baseUrl: "https://api.test", fetch });
  await expect(c.getSite({ name: "ghost" })).rejects.toThrow("no such site");
  try {
    await c.getSite({ name: "ghost" });
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(DropApiError);
    expect((e as DropApiError).status).toBe(404);
    expect((e as DropApiError).body).toEqual({ error: "no such site" });
  }
});
