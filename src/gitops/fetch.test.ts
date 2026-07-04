// (B3) fetch.ts — raw-URL resolution per provider (GitHub / GitLab / generic), the provider auth
// header, and the bounded fetch with an INJECTED fetchImpl (no network ever). Change detection is a
// sha256 of the fetched content — asserted stable + content-sensitive here.
import { test, expect } from "bun:test";
import { authHeaders, contentSha, fetchStackFile, resolveRawUrl } from "./fetch.ts";

// ---- URL resolution ---------------------------------------------------------------------------------

test("B3 fetch: GitHub https / .git / ssh forms all resolve to raw.githubusercontent.com", () => {
  const want = "https://raw.githubusercontent.com/acme/shop/main/drop.yaml";
  for (const repo of ["https://github.com/acme/shop", "https://github.com/acme/shop.git", "https://github.com/acme/shop/", "git@github.com:acme/shop.git"]) {
    const r = resolveRawUrl({ repo, branch: "main", path: "drop.yaml" });
    expect(r.provider).toBe("github");
    expect(r.url).toBe(want);
  }
  // slash-bearing branch + nested path encode per segment (the slashes survive)
  const nested = resolveRawUrl({ repo: "https://github.com/acme/shop", branch: "feat/x y", path: "deploy/drop.yaml" });
  expect(nested.url).toBe("https://raw.githubusercontent.com/acme/shop/feat/x%20y/deploy/drop.yaml");
});

test("B3 fetch: GitLab (gitlab.com + self-hosted gitlab.*) resolves to /-/raw/, nested groups intact", () => {
  const r = resolveRawUrl({ repo: "https://gitlab.com/acme/platform/shop.git", branch: "main", path: "drop.yaml" });
  expect(r.provider).toBe("gitlab");
  expect(r.url).toBe("https://gitlab.com/acme/platform/shop/-/raw/main/drop.yaml");
  const selfHosted = resolveRawUrl({ repo: "https://gitlab.corp.example/acme/shop", branch: "release", path: "drop.yaml" });
  expect(selfHosted.provider).toBe("gitlab");
  expect(selfHosted.url).toBe("https://gitlab.corp.example/acme/shop/-/raw/release/drop.yaml");
});

test("B3 fetch: any other URL is generic — treated as the raw file URL itself", () => {
  const r = resolveRawUrl({ repo: "https://git.example.com/acme/shop/raw/branch/main/drop.yaml", branch: "main", path: "drop.yaml" });
  expect(r.provider).toBe("generic");
  expect(r.url).toBe("https://git.example.com/acme/shop/raw/branch/main/drop.yaml");
});

test("B3 fetch: junk / non-http repo URLs are refused with a clean error", () => {
  expect(() => resolveRawUrl({ repo: "not a url", branch: "main", path: "drop.yaml" })).toThrow(/unsupported repo URL/);
  expect(() => resolveRawUrl({ repo: "ftp://github.com/acme/shop", branch: "main", path: "drop.yaml" })).toThrow(/scheme/);
  expect(() => resolveRawUrl({ repo: "https://github.com/acme", branch: "main", path: "drop.yaml" })).toThrow(/owner.*repo/);
});

test("B3 fetch: auth headers per provider; no token → no header; token never in the URL", () => {
  expect(authHeaders("github", "tok")).toEqual({ authorization: "Bearer tok" });
  expect(authHeaders("generic", "tok")).toEqual({ authorization: "Bearer tok" });
  expect(authHeaders("gitlab", "tok")).toEqual({ "private-token": "tok" });
  expect(authHeaders("github")).toEqual({});
  const r = resolveRawUrl({ repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml" });
  expect(r.url).not.toContain("tok");
});

// ---- the bounded fetch (injected transport) ----------------------------------------------------------

const YAML = "stack:\n  name: shop\n  resources:\n    db:\n      type: database\n";

test("B3 fetch: fetchStackFile returns the content + its sha256; the token rides the auth header", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    return new Response(YAML, { status: 200 });
  };
  const r = await fetchStackFile({ repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml", token: "ghp_abc" }, { fetchImpl });
  expect(r.content).toBe(YAML);
  expect(r.sha).toBe(contentSha(YAML));
  expect(r.sha).toHaveLength(64);
  expect(calls[0]!.url).toBe("https://raw.githubusercontent.com/acme/shop/main/drop.yaml");
  expect(calls[0]!.headers.authorization).toBe("Bearer ghp_abc");
  // change detection: a different body yields a different sha; the same body the same sha
  expect(contentSha(YAML + "# change\n")).not.toBe(r.sha);
  expect(contentSha(YAML)).toBe(r.sha);
});

test("B3 fetch: 404 / non-OK / oversized / thrown transport all fail with clean, token-free errors", async () => {
  const src = { repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml", token: "sekret" };
  const respond = (res: Response) => async () => res;

  await expect(fetchStackFile(src, { fetchImpl: respond(new Response("nope", { status: 404 })) })).rejects.toThrow(/file not found: drop.yaml @ main/);
  // a token-less 404 hints at the private-repo cause
  await expect(fetchStackFile({ ...src, token: undefined }, { fetchImpl: respond(new Response("nope", { status: 404 })) })).rejects.toThrow(/needs a token/);
  await expect(fetchStackFile(src, { fetchImpl: respond(new Response("boom", { status: 500 })) })).rejects.toThrow(/fetch returned 500/);
  await expect(fetchStackFile(src, { fetchImpl: respond(new Response("x".repeat(2048), { status: 200 })), maxBytes: 1024 })).rejects.toThrow(/file too large/);
  await expect(
    fetchStackFile(src, {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED 1.2.3.4 sekret-should-not-leak");
      },
    }),
  ).rejects.toThrow(/^fetch failed \(raw\.githubusercontent\.com\)$/); // transport detail (which could echo anything) is dropped

  // none of the error messages carry the token
  for (const p of [
    fetchStackFile(src, { fetchImpl: respond(new Response("nope", { status: 401 })) }),
    fetchStackFile(src, { fetchImpl: respond(new Response("x".repeat(2048), { status: 200 })), maxBytes: 1024 }),
  ]) {
    await p.catch((e: Error) => expect(e.message).not.toContain("sekret"));
  }
});

test("B3 fetch: the timeout aborts a hung transport", async () => {
  const fetchImpl = (_url: string, init: RequestInit) =>
    new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    });
  await expect(fetchStackFile({ repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml" }, { fetchImpl, timeoutMs: 20 })).rejects.toThrow(/fetch timed out/);
});
