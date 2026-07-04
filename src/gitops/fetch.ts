// (B3) Raw-file fetch for GitOps links. Given {repo, branch, path, token?} resolve the provider's raw
// URL and fetch the file. Hand-rolled fetch, NO SDK, NO new deps (the F2 llm client posture):
//   - GitHub:  https://github.com/<owner>/<repo>[.git] (or git@github.com:owner/repo.git)
//              → https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>
//   - GitLab:  https://gitlab.com/<group…>/<repo>[.git] (any `gitlab.*` host, so self-hosted works)
//              → <origin>/<project>/-/raw/<branch>/<path>
//   - generic: any OTHER URL is treated as the raw file URL ITSELF (already fully qualified — e.g. a
//              Gitea /raw/ link or a plain static host); branch/path are informational only.
// Change detection is a sha256 OF THE FETCHED CONTENT — simple and provider-agnostic (no git plumbing,
// works identically for the generic host); a git-commit-sha optimization (skip the body read when the
// ref didn't move) is a documented follow-up. Private repos: `token` rides the provider's auth header
// (GitHub/generic `Authorization: Bearer`, GitLab `PRIVATE-TOKEN`) — never the URL, never a log line,
// never an error message. Bounded read + timeout so a hostile/broken host can't wedge the poller.
import { createHash } from "node:crypto";

/** `fetch` is injectable purely for tests (fetch.test.ts / the route tests script a fake); prod passes
 *  the global. Same seam shape as the F2 llm client. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GitopsSource {
  repo: string;
  branch: string;
  path: string;
  token?: string;
}

export type GitProvider = "github" | "gitlab" | "generic";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 512 * 1024; // a drop.yaml is tiny; this is a DoS bound, not a quota

/** sha256 hex of the file content — the poller's change-detection key (`stack_links.last_sha`). */
export function contentSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Encode a slash-bearing ref/path segment-by-segment (branches like `feat/x`, paths like `deploy/drop.yaml`).
const encSegments = (s: string): string => s.split("/").map(encodeURIComponent).join("/");

/** Resolve the raw-file URL + provider for a source. Throws (token-free message) on an unusable repo. */
export function resolveRawUrl(src: Pick<GitopsSource, "repo" | "branch" | "path">): { url: string; provider: GitProvider } {
  const cleaned = src.repo.trim().replace(/\/+$/, "");
  // `git@host:owner/repo.git` → `https://host/owner/repo.git` so one URL parse covers both forms.
  const ssh = /^git@([^:/]+):(.+)$/.exec(cleaned);
  const httpish = ssh ? `https://${ssh[1]}/${ssh[2]}` : cleaned;
  let u: URL;
  try {
    u = new URL(httpish);
  } catch {
    throw new Error(`unsupported repo URL (want https://… or git@host:owner/repo)`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`unsupported repo URL scheme: ${u.protocol.replace(/:$/, "")}`);
  const project = u.pathname.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const host = u.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    if (!/^[^/]+\/[^/]+$/.test(project)) throw new Error(`a GitHub repo URL must be https://github.com/<owner>/<repo>`);
    return { url: `https://raw.githubusercontent.com/${project}/${encSegments(src.branch)}/${encSegments(src.path)}`, provider: "github" };
  }
  if (host === "gitlab.com" || host.startsWith("gitlab.")) {
    if (!project) throw new Error(`a GitLab repo URL must include the project path`);
    return { url: `${u.origin}/${project}/-/raw/${encSegments(src.branch)}/${encSegments(src.path)}`, provider: "gitlab" };
  }
  // Generic: the repo value IS the raw file URL (point --repo straight at the file on any other host).
  return { url: httpish, provider: "generic" };
}

/** The provider's auth header for a token. GitLab raw files want PRIVATE-TOKEN; GitHub + generic hosts
 *  take the standard Bearer header. The token NEVER rides the URL. */
export function authHeaders(provider: GitProvider, token?: string): Record<string, string> {
  if (!token) return {};
  return provider === "gitlab" ? { "private-token": token } : { authorization: `Bearer ${token}` };
}

/** Fetch the linked file: resolve the raw URL, GET it (auth header for private repos, bounded size +
 *  timeout), and return `{ sha, content }` where sha is the content sha256. Every thrown Error carries a
 *  clean, token-free message (it lands verbatim in `last_error` / the G3 event). */
export async function fetchStackFile(
  src: GitopsSource,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ sha: string; content: string }> {
  const { url, provider } = resolveRawUrl(src);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", signal: ctrl.signal, headers: authHeaders(provider, src.token) });
  } catch (e) {
    // Includes the AbortError on timeout. Host only — never the full URL chain or any header.
    throw new Error((e as Error).name === "AbortError" ? `fetch timed out (${new URL(url).host})` : `fetch failed (${new URL(url).host})`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) {
    throw new Error(`file not found: ${src.path} @ ${src.branch}${src.token ? "" : " (a private repo needs a token — drop stack link … --token)"}`);
  }
  if (!res.ok) throw new Error(`fetch returned ${res.status}`); // status only — no body, no headers
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len && len > maxBytes) throw new Error(`file too large (> ${Math.round(maxBytes / 1024)} KiB)`);
  const content = await res.text();
  if (content.length > maxBytes) throw new Error(`file too large (> ${Math.round(maxBytes / 1024)} KiB)`);
  return { sha: contentSha(content), content };
}
