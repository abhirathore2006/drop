// (G3) Outbound webhook delivery for the org events feed. Runs IN the API process — no new infra, no
// queue: on a NEW open incident (and on recovery) the EventStore fires ONE delivery here, in the
// background (the request path never waits on it). Delivery posture is therefore best-effort
// AT-MOST-ONCE: the bounded retry/backoff below rides over a transient webhook failure within a single
// process, but a crash/restart mid-delivery does NOT replay — the durable record is the `events` table
// (a human can always re-read the feed). This is the honest trade for "no new infra".
//
// Payload: a GENERIC JSON shape (`{kind,title,severity,detail,url,siteName,at,resolved}`) that any
// endpoint can consume. When the URL host looks like a Slack incoming webhook (hooks.slack.com), we ALSO
// send Slack's minimal `{text}` shape so a raw Slack/Mattermost hook renders a readable line without a
// bespoke adapter (a richer Slack Block Kit adapter is a follow-up). Teams incoming webhooks accept the
// generic JSON. When a `secret` is configured the body is HMAC-SHA256-signed as
// `X-Drop-Signature: sha256=<hex>` so the receiver can verify authenticity.
import { createHmac } from "node:crypto";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** The event shape delivery needs (a subset of EventRecord — kept local so webhook.ts has no store dep). */
export interface DeliverableEvent {
  kind: string;
  severity: string;
  title: string;
  siteName: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface WebhookTarget {
  url: string;
  secret: string | null;
}

export interface DeliveryOpts {
  fetchImpl?: FetchLike;
  retries?: number; // total attempts (default 3)
  backoffMs?: number; // base backoff, doubled each retry (default 500ms)
  timeoutMs?: number; // per-attempt timeout (default 5s)
  sleep?: (ms: number) => Promise<void>; // injectable for tests (default real setTimeout)
}

/** A Slack incoming webhook host — these accept `{text}` and 404 on our generic body, so we adapt. */
export function isSlackWebhook(url: string): boolean {
  try {
    return new URL(url).host === "hooks.slack.com";
  } catch {
    return false;
  }
}

/** A one-line human summary used as the Slack `text` (and handy in logs). */
export function summaryLine(e: DeliverableEvent): string {
  const icon = e.resolvedAt ? "✅" : e.severity === "error" ? "🔴" : e.severity === "warning" ? "🟠" : "🔵";
  const state = e.resolvedAt ? "resolved" : e.severity;
  const where = e.siteName ? ` · ${e.siteName}` : "";
  return `${icon} [drop] ${state}: ${e.title}${where}`;
}

/** Build the request body for `target`. Slack hosts get `{text}`; everyone else the generic event JSON. */
export function buildPayload(target: WebhookTarget, e: DeliverableEvent): string {
  if (isSlackWebhook(target.url)) return JSON.stringify({ text: summaryLine(e) });
  return JSON.stringify({
    kind: e.kind,
    title: e.title,
    severity: e.severity,
    siteName: e.siteName,
    detail: e.detail,
    at: e.createdAt,
    resolved: e.resolvedAt != null,
    resolvedAt: e.resolvedAt,
    text: summaryLine(e), // included so simple consumers have a ready-made line too
  });
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POST the event to `target` with a bounded retry/backoff. Resolves `{ ok, attempts }` — NEVER throws
 *  (the caller fires this in the background and only logs). A non-2xx or a network error is retried up
 *  to `retries` total attempts; a 4xx that isn't 408/429 is treated as permanent (a misconfigured URL
 *  won't fix itself, so we stop early rather than burn all retries). */
export async function deliverEvent(target: WebhookTarget, e: DeliverableEvent, opts: DeliveryOpts = {}): Promise<{ ok: boolean; attempts: number; status: number }> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const sleep = opts.sleep ?? realSleep;
  const body = buildPayload(target, e);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "drop-events/1" };
  if (target.secret) headers["x-drop-signature"] = "sha256=" + createHmac("sha256", target.secret).update(body).digest("hex");

  let lastStatus = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let status = 0;
    let ok = false;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(target.url, { method: "POST", headers, body, signal: ac.signal });
        status = res.status;
        ok = res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* network error / abort → treat as a retryable failure */
    }
    lastStatus = status;
    if (ok) return { ok: true, attempts: attempt, status };
    // A permanent client error (bad URL / rejected) won't recover — stop early (408/429 are transient).
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { ok: false, attempts: attempt, status };
    if (attempt < retries) await sleep(backoffMs * 2 ** (attempt - 1));
  }
  return { ok: false, attempts: retries, status: lastStatus };
}

// The default transport wraps global fetch into the tiny FetchLike shape (so tests inject a fake).
const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  return { ok: res.ok, status: res.status };
};
