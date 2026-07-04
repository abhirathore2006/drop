import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { deliverEvent, buildPayload, isSlackWebhook, summaryLine, type DeliverableEvent, type FetchLike } from "./webhook.ts";

const ev = (over: Partial<DeliverableEvent> = {}): DeliverableEvent => ({
  kind: "crashloop",
  severity: "error",
  title: "crash-loop: api",
  siteName: "api",
  detail: { restarts: 5 },
  createdAt: "2026-07-04T00:00:00.000Z",
  resolvedAt: null,
  ...over,
});

// A fake transport recording every request; `plan` scripts the status per attempt.
function fakeFetch(plan: number[]): { fn: FetchLike; calls: { url: string; headers: Record<string, string>; body: string }[] } {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const status = plan[Math.min(i, plan.length - 1)]!;
    i++;
    return { ok: status >= 200 && status < 300, status };
  };
  return { fn, calls };
}

const noSleep = async () => {};

test("success on the first attempt", async () => {
  const { fn, calls } = fakeFetch([200]);
  const r = await deliverEvent({ url: "https://hooks.example.com/x", secret: null }, ev(), { fetchImpl: fn, sleep: noSleep });
  expect(r).toEqual({ ok: true, attempts: 1, status: 200 });
  expect(calls.length).toBe(1);
});

test("retries a 5xx then gives up after `retries` attempts", async () => {
  const { fn, calls } = fakeFetch([500, 502, 503]);
  const r = await deliverEvent({ url: "https://hooks.example.com/x", secret: null }, ev(), { fetchImpl: fn, retries: 3, sleep: noSleep });
  expect(r.ok).toBe(false);
  expect(r.attempts).toBe(3);
  expect(calls.length).toBe(3);
});

test("retries a 5xx then succeeds on the next attempt", async () => {
  const { fn, calls } = fakeFetch([503, 200]);
  const r = await deliverEvent({ url: "https://hooks.example.com/x", secret: null }, ev(), { fetchImpl: fn, retries: 3, sleep: noSleep });
  expect(r).toEqual({ ok: true, attempts: 2, status: 200 });
  expect(calls.length).toBe(2);
});

test("a permanent 4xx (bad URL) stops early — no wasted retries", async () => {
  const { fn, calls } = fakeFetch([404, 200]);
  const r = await deliverEvent({ url: "https://hooks.example.com/x", secret: null }, ev(), { fetchImpl: fn, retries: 3, sleep: noSleep });
  expect(r.ok).toBe(false);
  expect(r.attempts).toBe(1); // stopped after the 404, didn't retry
  expect(calls.length).toBe(1);
});

test("a 429 IS retried (transient rate-limit)", async () => {
  const { fn, calls } = fakeFetch([429, 200]);
  const r = await deliverEvent({ url: "https://hooks.example.com/x", secret: null }, ev(), { fetchImpl: fn, retries: 3, sleep: noSleep });
  expect(r.ok).toBe(true);
  expect(calls.length).toBe(2);
});

test("HMAC signature header present + correct when a secret is set; absent otherwise", async () => {
  const secret = "topsecret";
  const { fn, calls } = fakeFetch([200]);
  await deliverEvent({ url: "https://hooks.example.com/x", secret }, ev(), { fetchImpl: fn, sleep: noSleep });
  const sent = calls[0]!;
  const expected = "sha256=" + createHmac("sha256", secret).update(sent.body).digest("hex");
  expect(sent.headers["x-drop-signature"]).toBe(expected);

  const { fn: fn2, calls: calls2 } = fakeFetch([200]);
  await deliverEvent({ url: "https://hooks.example.com/x", secret: null }, ev(), { fetchImpl: fn2, sleep: noSleep });
  expect(calls2[0]!.headers["x-drop-signature"]).toBeUndefined();
});

test("Slack host gets a {text} body; generic host gets the full event JSON", async () => {
  expect(isSlackWebhook("https://hooks.slack.com/services/T/B/X")).toBe(true);
  expect(isSlackWebhook("https://example.com/x")).toBe(false);

  const slack = JSON.parse(buildPayload({ url: "https://hooks.slack.com/services/T/B/X", secret: null }, ev()));
  expect(Object.keys(slack)).toEqual(["text"]);
  expect(slack.text).toBe(summaryLine(ev()));

  const generic = JSON.parse(buildPayload({ url: "https://example.com/hook", secret: null }, ev({ resolvedAt: "2026-07-04T01:00:00.000Z" })));
  expect(generic.kind).toBe("crashloop");
  expect(generic.severity).toBe("error");
  expect(generic.siteName).toBe("api");
  expect(generic.resolved).toBe(true); // resolvedAt set → resolved:true
  expect(generic.detail).toEqual({ restarts: 5 });
});

test("summaryLine reflects severity + resolved state", () => {
  expect(summaryLine(ev({ severity: "error", resolvedAt: null }))).toContain("error");
  expect(summaryLine(ev({ resolvedAt: "2026-07-04T01:00:00.000Z" }))).toContain("resolved");
});
