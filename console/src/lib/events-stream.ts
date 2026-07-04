// (M4) The live event stream client — an EventSource wrapper that turns each server-pushed G3 event into
// TanStack query invalidations, so the activity feed, the workloads list, the stack canvas status, and
// the unread badge flip in real time instead of on their next poll. The endpoint is GET /v1/events/stream
// (text/event-stream, org-scoped by the session cookie).
//
// Design notes:
//  - The event→invalidation MAPPING is a pure function (invalidationKeysFor) so it unit-tests with a
//    stubbed EventSource; the wrapper only opens the socket and applies the mapping.
//  - Graceful degradation: on an older API the endpoint 404s → EventSource lands in CLOSED immediately;
//    we stop and let the existing polling carry the UI (nothing else to do — every surface still polls).
//  - Session expiry: EventSource can't read a 401 body, so on a hard close we re-check /v1/me out of band;
//    a real expiry flips the shared sessionExpiry store exactly as the query layer's 401 interceptor does.
//  - A transient network drop leaves EventSource in CONNECTING and it reconnects on its own (the server
//    sends heartbeat comments to keep proxies from idling the connection shut).
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { rememberLocation, sessionExpiry } from "./query.ts";

export const EVENT_STREAM_PATH = "/v1/events/stream";

/** One frame the server pushes (SSE `event: event`, JSON data). `orgSlug` is resolved server-side from the
 *  caller's memberships so the client can target the right per-org feed key. */
export interface StreamedEvent {
  id: string;
  orgId: string;
  orgSlug: string | null;
  siteName: string | null;
  kind: string;
  severity: "info" | "warning" | "error";
}

/** Map a streamed event to the query keys to invalidate. PURE + the tested seam.
 *
 *  - `["/v1/me"]` — the frame's unread-incidents badge.
 *  - `["/v1/sites"]` — the workloads list AND every open detail (prefix match) whose status may have
 *    flipped (a crash-loop/deploy event changes health).
 *  - `["/v1/stacks"]` — the stacks list AND every open stack graph (prefix match) so the canvas node
 *    status flips live. (We can't cheaply map a resource name back to its stack, so we refresh the small
 *    set of open graph queries by prefix rather than target one.)
 *  - `["/v1/orgs", slug, "events"]` — the activity feed for the event's org (when its slug is known). */
export function invalidationKeysFor(e: StreamedEvent): QueryKey[] {
  const keys: QueryKey[] = [["/v1/me"], ["/v1/sites"], ["/v1/stacks"]];
  if (e.orgSlug) keys.push(["/v1/orgs", e.orgSlug, "events"]);
  return keys;
}

export interface EventStreamOpts {
  enabled?: boolean; // feature flag; default on. Set false to force polling-only.
  /** Injectable for tests — defaults to the global EventSource (undefined in SSR/old browsers → no-op). */
  EventSourceImpl?: typeof EventSource;
  /** Injectable session re-check (tests); defaults to a /v1/me probe. */
  recheckSession?: () => void;
}

const noop = (): void => {};

/** Open the stream and wire invalidations into `qc`. Returns a disposer (call on unmount). A no-op when
 *  disabled or when EventSource is unavailable — the UI then relies purely on TanStack polling. */
export function startEventStream(qc: QueryClient, opts: EventStreamOpts = {}): () => void {
  if (opts.enabled === false) return noop;
  const Impl = opts.EventSourceImpl ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
  if (!Impl) return noop;

  let closed = false;
  const es = new Impl(EVENT_STREAM_PATH, { withCredentials: true });
  const recheck = opts.recheckSession ?? defaultRecheckSession;

  const close = () => {
    closed = true;
    es.close();
  };

  es.addEventListener("event", (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as StreamedEvent;
      for (const key of invalidationKeysFor(data)) void qc.invalidateQueries({ queryKey: key });
    } catch {
      /* ignore a malformed frame — the next poll reconciles anyway */
    }
  });

  es.onerror = () => {
    if (closed) return;
    // CLOSED = the endpoint is gone (older API 404) or the connection was hard-rejected: stop and fall
    // back to polling, and re-check the session in case it was a 401. CONNECTING = a transient drop —
    // EventSource reconnects itself, so leave it alone.
    if (es.readyState === (Impl as unknown as { CLOSED: number }).CLOSED) {
      close();
      recheck();
    }
  };

  return close;
}

function defaultRecheckSession(): void {
  void fetch("/v1/me")
    .then((res) => {
      if (res.status === 401) {
        rememberLocation();
        sessionExpiry.set(true);
      }
    })
    .catch(() => {
      /* offline — a real 401 surfaces on the next authenticated poll's interceptor */
    });
}
