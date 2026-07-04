// (M4) The SSE client's pure invalidation mapping + the wrapper's wiring, with EventSource stubbed.
// uPlot/DOM aren't involved; this is the adapter seam that keeps the live feed logic testable.
import { describe, expect, test } from "bun:test";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { invalidationKeysFor, startEventStream, type StreamedEvent } from "./events-stream.ts";

const evt = (over: Partial<StreamedEvent> = {}): StreamedEvent => ({ id: "42", orgId: "o1", orgSlug: "acme", siteName: "shop-api", kind: "crashloop", severity: "error", ...over });

describe("invalidationKeysFor", () => {
  test("always refreshes the badge, list, and stacks (prefix-matched)", () => {
    const keys = invalidationKeysFor(evt({ orgSlug: null }));
    expect(keys).toContainEqual(["/v1/me"]);
    expect(keys).toContainEqual(["/v1/sites"]);
    expect(keys).toContainEqual(["/v1/stacks"]);
    // no org slug → no per-org feed key
    expect(keys.some((k) => (k as string[])[0] === "/v1/orgs")).toBe(false);
  });
  test("adds the org events feed key when the slug is known", () => {
    expect(invalidationKeysFor(evt({ orgSlug: "acme" }))).toContainEqual(["/v1/orgs", "acme", "events"]);
  });
});

// A minimal EventSource stub: records instances, lets the test push frames + errors synchronously.
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (ev: { data: string }) => void>();
  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    this.listeners.set(type, fn);
  }
  emit(type: string, data: string) {
    this.listeners.get(type)?.({ data });
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function fakeClient() {
  const calls: QueryKey[] = [];
  const qc = { invalidateQueries: (a: { queryKey: QueryKey }) => calls.push(a.queryKey) } as unknown as QueryClient;
  return { qc, calls };
}

describe("startEventStream", () => {
  test("feature flag off → no connection", () => {
    FakeEventSource.instances = [];
    const { qc } = fakeClient();
    const dispose = startEventStream(qc, { enabled: false, EventSourceImpl: FakeEventSource as unknown as typeof EventSource });
    expect(FakeEventSource.instances.length).toBe(0);
    dispose();
  });

  test("a pushed event fans out to the mapped invalidations", () => {
    FakeEventSource.instances = [];
    const { qc, calls } = fakeClient();
    const dispose = startEventStream(qc, { EventSourceImpl: FakeEventSource as unknown as typeof EventSource });
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/v1/events/stream");
    expect(es.init?.withCredentials).toBe(true);

    es.emit("event", JSON.stringify(evt({ orgSlug: "acme" })));
    expect(calls).toContainEqual(["/v1/me"]);
    expect(calls).toContainEqual(["/v1/sites"]);
    expect(calls).toContainEqual(["/v1/stacks"]);
    expect(calls).toContainEqual(["/v1/orgs", "acme", "events"]);
    dispose();
  });

  test("a malformed frame is ignored (no throw, no invalidation)", () => {
    FakeEventSource.instances = [];
    const { qc, calls } = fakeClient();
    const dispose = startEventStream(qc, { EventSourceImpl: FakeEventSource as unknown as typeof EventSource });
    FakeEventSource.instances[0]!.emit("event", "{not json");
    expect(calls.length).toBe(0);
    dispose();
  });

  test("a hard CLOSED error re-checks the session and stops (degrade to polling)", () => {
    FakeEventSource.instances = [];
    const { qc } = fakeClient();
    let rechecked = false;
    const dispose = startEventStream(qc, { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, recheckSession: () => (rechecked = true) });
    const es = FakeEventSource.instances[0]!;
    es.fail(FakeEventSource.CLOSED);
    expect(rechecked).toBe(true);
    expect(es.readyState).toBe(FakeEventSource.CLOSED); // closed, won't reconnect
    dispose();
  });

  test("a transient CONNECTING error does NOT re-check or close (EventSource retries)", () => {
    FakeEventSource.instances = [];
    const { qc } = fakeClient();
    let rechecked = false;
    const dispose = startEventStream(qc, { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, recheckSession: () => (rechecked = true) });
    FakeEventSource.instances[0]!.fail(FakeEventSource.CONNECTING);
    expect(rechecked).toBe(false);
    dispose();
  });
});
