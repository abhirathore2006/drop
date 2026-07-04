// Live logs (G1 → M3): a fetch-stream reader over `GET /v1/sites/:name/logs?follow=1` rendered into a
// virtualized, greppable, auto-following log view. ONE component across the surfaces that share the
// follow endpoint:
//   • app   (type="app")      — process selector (web + workers) + a --release one-shot toggle.
//   • database (type="database") — follow only (no processes, no release Jobs).
// A release Job (?release=1) runs once and exits, so follow+release is a 400 server-side; the release
// toggle switches to a one-shot fetch instead of streaming. All streaming state rides the shared
// StreamHeader (live / reconnecting / closed) and a mid-stream 401 routes through the M0 session-expiry
// interceptor (the same store the query layer flips), so an expired session surfaces the login gate.
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { StreamHeader, type StreamState } from "../../components/StreamHeader.tsx";
import { ApiError, api, followLogs, type WorkloadType } from "../../lib/api.ts";
import { rememberLocation, sessionExpiry } from "../../lib/query.ts";
import { computeWindow, dumpLines, grepLines, LOG_BUFFER_CAP, type LogLine, splitStreamChunk } from "../../lib/log-view.ts";

const LINE_H = 18; // px — must match `.logline` height in components.css for correct virtualization
const TAIL = 500; // initial backlog requested on connect
const RECONNECT_MS = 2000; // backoff before re-opening a dropped follow stream

// (G4) The quick-window picker for historical search — each maps to a lookback measured back from now.
const RANGE_MS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
type HistState = "idle" | "loading" | "done" | "error";

export function LogsPanel({ name, type }: { name: string; type: WorkloadType }) {
  const isApp = type === "app";
  const [lines, setLines] = useState<LogLine[]>([]);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [process, setProcess] = useState("web");
  const [release, setRelease] = useState(false);
  const [state, setState] = useState<StreamState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(360);

  // (G4) History mode: search the retained S3 log objects (grep-grade) instead of the live tail. The live
  // stream is left completely untouched — toggling to "history" just parks it and drives a separate,
  // server-side search into `histLines`.
  const [mode, setMode] = useState<"live" | "history">("live");
  const [histRange, setHistRange] = useState<"1h" | "24h" | "7d">("24h");
  const [histQuery, setHistQuery] = useState("");
  const [histLines, setHistLines] = useState<LogLine[]>([]);
  const [histState, setHistState] = useState<HistState>("idle");
  const [histTruncated, setHistTruncated] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);

  const idRef = useRef(0);
  const carryRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // App process list (web + workers) — populates the selector. Databases have no processes.
  const procs = useQuery({
    queryKey: ["/v1/apps", name, "processes"],
    queryFn: () => api.processes(name),
    enabled: isApp,
    staleTime: 30_000,
  });
  const workerProcs = procs.data?.processes ?? [];

  const reset = useCallback(() => {
    idRef.current = 0;
    carryRef.current = "";
    setLines([]);
    setError(null);
  }, []);

  const push = useCallback((newLines: string[]) => {
    if (!newLines.length) return;
    setLines((prev) => {
      const next = prev.concat(newLines.map((text) => ({ id: idRef.current++, text })));
      return next.length > LOG_BUFFER_CAP ? next.slice(next.length - LOG_BUFFER_CAP) : next;
    });
  }, []);

  // The stream / one-shot lifecycle. Re-runs when the target (name / process / release / mode) changes.
  useEffect(() => {
    // History mode owns the view via runHistory — never open the live stream (and the cleanup from the
    // previous live run has already aborted any in-flight follow).
    if (mode !== "live") return;
    let aborted = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    reset();

    const route401 = (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        rememberLocation();
        sessionExpiry.set(true);
        return true;
      }
      return false;
    };

    // Release Jobs run once and exit → a one-shot tail, never a stream.
    if (release) {
      setState("connecting");
      api
        .releaseLogs(name)
        .then((r) => {
          if (aborted) return;
          const parts = r.logs ? r.logs.split("\n") : [];
          if (parts.length && parts[parts.length - 1] === "") parts.pop();
          push(parts);
          setState("closed");
        })
        .catch((e) => {
          if (aborted) return;
          if (!route401(e)) setError((e as Error).message);
          setState("closed");
        });
      return () => {
        aborted = true;
      };
    }

    const connect = async () => {
      if (aborted) return;
      setState("connecting");
      controller = new AbortController();
      try {
        const res = await followLogs(name, { tail: TAIL, process, signal: controller.signal });
        if (aborted) return;
        const body = res.body;
        if (!body) {
          setState("closed");
          return;
        }
        setState("live");
        const reader = body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (aborted) return;
          if (done) break;
          const { lines: complete, carry } = splitStreamChunk(carryRef.current, decoder.decode(value, { stream: true }));
          carryRef.current = carry;
          push(complete);
        }
        // Stream ended (pod gone / rotated): flush any partial line, then reconnect.
        if (carryRef.current) {
          push([carryRef.current]);
          carryRef.current = "";
        }
        if (!aborted) {
          setState("reconnecting");
          retry = setTimeout(connect, RECONNECT_MS);
        }
      } catch (e) {
        if (aborted || (e as Error).name === "AbortError") return;
        if (route401(e)) {
          setState("closed");
          return;
        }
        setError((e as Error).message);
        setState("reconnecting");
        retry = setTimeout(connect, RECONNECT_MS);
      }
    };
    void connect();

    return () => {
      aborted = true;
      if (retry) clearTimeout(retry);
      controller?.abort();
    };
  }, [name, process, release, reset, push, mode]);

  // (G4) Run a historical search over the retained objects. Grep runs SERVER-side, so the results list is
  // rendered as-is (no client grep filter in history mode).
  const runHistory = useCallback(async () => {
    setHistState("loading");
    setHistError(null);
    const to = new Date().toISOString();
    const from = new Date(Date.now() - RANGE_MS[histRange]!).toISOString();
    try {
      const r = await api.logsSearch(name, { from, to, q: histQuery || undefined, limit: 1000 });
      setHistLines(r.lines.map((h, i) => ({ id: i, text: h.line })));
      setHistTruncated(r.truncated);
      setHistState("done");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        rememberLocation();
        sessionExpiry.set(true);
        return;
      }
      setHistError((e as Error).message);
      setHistState("error");
    }
  }, [name, histRange, histQuery]);

  // Auto-follow: when following, keep the viewport pinned to the newest line as it arrives.
  useLayoutEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  // Measure the viewport once mounted (fixed-height container, but read it honestly).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewportH(el.clientHeight || 360);
  }, []);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight || 360);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_H * 2;
    // Pause-on-scroll-up; re-arm follow when the user returns to the bottom.
    if (follow && !atBottom) setFollow(false);
    else if (!follow && atBottom) setFollow(true);
  };

  // Live mode filters the buffered tail client-side; history mode renders the server-side search results
  // as-is (its grep already ran on the server). Same virtualization windowing drives both.
  const displayLines = mode === "live" ? grepLines(lines, query) : histLines;
  const total = displayLines.length;
  // When live-following, window onto the tail regardless of the last scroll position (new lines shift it).
  const st = mode === "live" && follow ? Math.max(0, total * LINE_H - viewportH) : scrollTop;
  const win = computeWindow(total, st, viewportH, LINE_H);
  const visible = displayLines.slice(win.start, win.end);

  const download = () => {
    const blob = new Blob([dumpLines(mode === "live" ? lines : histLines)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const actions = (
    <div className="stream-actions">
      {/* (G4) live tail vs. searchable history — the live stream is untouched; history parks it. */}
      <Button size="sm" variant={mode === "live" ? "primary" : "default"} onClick={() => setMode("live")} title="follow the live log stream">
        live
      </Button>
      <Button size="sm" variant={mode === "history" ? "primary" : "default"} onClick={() => setMode("history")} title="search the retained log history">
        history
      </Button>
      {mode === "live" && isApp && (
        <label className="stream-toggle" title="tail the latest release Job's output (one-shot)">
          <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />
          release
        </label>
      )}
      {mode === "live" && isApp && workerProcs.length > 1 && (
        <select className="stream-select" value={process} disabled={release} aria-label="process" onChange={(e) => setProcess(e.target.value)}>
          {workerProcs.map((p) => (
            <option key={p.process} value={p.process}>
              {p.process}
            </option>
          ))}
        </select>
      )}
      {mode === "live" && (
        <Button size="sm" variant={follow ? "primary" : "default"} disabled={release} onClick={() => setFollow((f) => !f)} title={follow ? "auto-scrolling — click to pause" : "paused — click to follow the tail"}>
          {follow ? "following" : "paused"}
        </Button>
      )}
      <Button size="sm" disabled={mode === "live" ? !lines.length : !histLines.length} onClick={download} title="download the buffered lines">
        download
      </Button>
    </div>
  );

  return (
    <div className="sec">
      <StreamHeader
        title="logs"
        state={mode === "live" ? state : histState === "loading" ? "connecting" : "closed"}
        label={mode === "history" ? "history" : release ? "release job" : undefined}
        actions={actions}
      />
      {mode === "live" ? (
        <input className="stream-grep" placeholder="filter (grep)..." value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="filter logs" />
      ) : (
        <div className="stream-actions" style={{ marginBottom: 8 }}>
          <select className="stream-select" value={histRange} aria-label="time range" onChange={(e) => setHistRange(e.target.value as "1h" | "24h" | "7d")}>
            <option value="1h">last 1h</option>
            <option value="24h">last 24h</option>
            <option value="7d">last 7d</option>
          </select>
          <input
            className="stream-grep"
            style={{ flex: 1, marginTop: 0 }}
            placeholder="search (substring)..."
            value={histQuery}
            onChange={(e) => setHistQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void runHistory()}
            spellCheck={false}
            aria-label="search history"
          />
          <Button size="sm" variant="primary" disabled={histState === "loading"} onClick={() => void runHistory()}>
            {histState === "loading" ? "searching..." : "search"}
          </Button>
        </div>
      )}
      {(mode === "live" ? error : histError) && <div className="err" style={{ marginTop: 8 }}>{mode === "live" ? error : histError}</div>}
      <div className="logstream" ref={scrollRef} onScroll={onScroll} role="log" aria-label="logs">
        {total === 0 ? (
          <div className="logline muted">
            {mode === "history"
              ? histState === "idle"
                ? "(search the retained history)"
                : histState === "loading"
                  ? "(searching...)"
                  : "(no matching lines)"
              : query
                ? "(no matching lines)"
                : "(no logs)"}
          </div>
        ) : (
          <div style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
            {visible.map((l) => (
              <div className="logline" key={l.id}>
                {l.text || " "}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sub" style={{ marginTop: 6 }}>
        {total.toLocaleString()} line{total === 1 ? "" : "s"}
        {mode === "live" && query && total !== lines.length ? ` of ${lines.length.toLocaleString()}` : ""}
        {mode === "live" && lines.length >= LOG_BUFFER_CAP ? ` · buffer capped at ${LOG_BUFFER_CAP.toLocaleString()}` : ""}
        {mode === "history" && histTruncated ? " · truncated (narrow the range or search)" : ""}
      </div>
    </div>
  );
}
