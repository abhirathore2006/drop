// Exec terminal (J3 → M3): a browser xterm.js console bridged to `GET /v1/apps/:name/exec` over a
// same-origin, cookie-authed WebSocket (the single-use ticket is the credential). The API + CLI
// transport already exist (J3); this is only the browser terminal.
//
// LAZY CHUNK: xterm, the fit addon, and xterm's stylesheet are pulled in via dynamic import() INSIDE the
// connect path, so they never enter the main bundle and only load when a shell is actually opened. The
// base stylesheet is imported (Vite extracts it to a hashed .css file loaded via <link>), covered by
// `style-src 'self'`.
//
// CSP NONCE: xterm's DOM renderer ALSO injects two runtime <style> elements (cell dimensions + ANSI
// theme) via createElement — governed by `style-src`, and blocked under a bare 'self'. Rather than
// weaken the CSP to 'unsafe-inline', the shell serves a per-response style nonce (in the CSP header +
// the <meta name="csp-style-nonce"> tag); `withStyleNonce` stamps that nonce onto every <style>
// created during term.open(), so the browser admits them. script-src stays strict 'self'.
//
// SECRETS ACK: a shell can `env` the container, so an app's write-only injected secrets become readable.
// The one-time-per-app confirm below states that up front; the ack is persisted in localStorage so it
// isn't nagged on every session.
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { StreamHeader, type StreamState } from "../../components/StreamHeader.tsx";
import { ApiError, api, execSocketUrl, type Detail } from "../../lib/api.ts";
import { decodeServerFrame, encodeResizeFrame, encodeStdin, toBytes } from "../../lib/exec-stream.ts";
import { rememberLocation, sessionExpiry } from "../../lib/query.ts";

/** The per-response CSP style nonce the API stamped into the shell's <meta> (empty under vite dev,
 *  which sets no strict CSP). */
const styleNonce = (): string => document.querySelector<HTMLMetaElement>('meta[name="csp-style-nonce"]')?.content ?? "";

/** Run `fn` (xterm's term.open) with document.createElement patched to stamp the CSP nonce onto any
 *  <style> element xterm injects, so `style-src 'nonce-…'` admits them. Restored immediately after —
 *  the nonce persists on those elements, so xterm's later textContent updates stay allowed. No-op when
 *  there's no nonce (dev). */
function withStyleNonce<T>(fn: () => T): T {
  const nonce = styleNonce();
  if (!nonce) return fn();
  const orig = document.createElement.bind(document);
  document.createElement = ((tag: string, opts?: ElementCreationOptions) => {
    const el = orig(tag, opts);
    if (String(tag).toLowerCase() === "style") (el as HTMLElement).setAttribute("nonce", nonce);
    return el;
  }) as typeof document.createElement;
  try {
    return fn();
  } finally {
    document.createElement = orig;
  }
}

const ackKey = (name: string) => `drop.exec.ack.${name}`;
const isAcked = (name: string): boolean => {
  try {
    return localStorage.getItem(ackKey(name)) === "1";
  } catch {
    return false;
  }
};

export function TerminalPanel({ d }: { d: Detail }) {
  const name = d.name;
  const [session, setSession] = useState(0); // 0 = no live session; each start/reconnect bumps it
  const [askAck, setAskAck] = useState(false);
  const [state, setState] = useState<StreamState>("idle");
  const [exit, setExit] = useState<number | null>(null); // remote exit code (marker 3), if any
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const openShell = () => {
    if (isAcked(name)) startSession();
    else setAskAck(true);
  };
  const startSession = () => {
    setExit(null);
    setError(null);
    setSession((s) => s + 1);
  };
  const ackAndOpen = () => {
    try {
      localStorage.setItem(ackKey(name), "1");
    } catch {
      /* private mode / storage disabled — proceed without persisting */
    }
    setAskAck(false);
    startSession();
  };
  const closeSession = () => {
    setSession(0);
    setState("idle");
  };

  // One connect per session id. The container is rendered (session>0) before this runs, so the ref is live.
  useEffect(() => {
    if (session === 0) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    const disposers: Array<() => void> = [];

    const route401 = (e: unknown): boolean => {
      if (e instanceof ApiError && e.status === 401) {
        rememberLocation();
        sessionExpiry.set(true);
        return true;
      }
      return false;
    };

    void (async () => {
      setState("connecting");
      // 1) mint the single-use exec ticket (bound to the default /bin/sh command server-side).
      let ticket;
      try {
        ticket = await api.execTicket(name);
      } catch (e) {
        if (disposed) return;
        if (!route401(e)) setError((e as Error).message);
        setState("closed");
        return;
      }
      if (disposed) return;

      // 2) the LAZY xterm chunk: the terminal, the fit addon, and the base stylesheet.
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      await import("@xterm/xterm/css/xterm.css");
      if (disposed || !containerRef.current) return;

      term = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12.5, scrollback: 5000, convertEol: false });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // Stamp the CSP style nonce onto xterm's injected <style> elements created during open().
      withStyleNonce(() => term!.open(containerRef.current!));
      try {
        fit.fit();
      } catch {
        /* zero-size container (not yet laid out) — a later resize fits it */
      }
      term.focus();

      const sendResize = () => {
        if (ws && ws.readyState === WebSocket.OPEN && term) ws.send(encodeResizeFrame(term.cols, term.rows));
      };

      // 3) the exec WebSocket (same-origin, cookie-authed; ticket in the query string).
      ws = new WebSocket(execSocketUrl(ticket.wsPath, ticket.ticket));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (disposed) return;
        setState("live");
        sendResize();
      };
      ws.onmessage = (ev) => {
        if (disposed || !term) return;
        const frame = decodeServerFrame(toBytes(ev.data as ArrayBuffer | string));
        if (frame.kind === "stdout" || frame.kind === "stderr") term.write(frame.data);
        else if (frame.kind === "exit") setExit(frame.code);
      };
      ws.onclose = () => {
        if (!disposed) setState("closed");
      };
      ws.onerror = () => {
        if (!disposed) setState("reconnecting");
      };

      // xterm → ws: keystrokes as raw-stdin binary frames; SIGWINCH-equivalent as a JSON resize.
      const dataSub = term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeStdin(data));
      });
      const resizeSub = term.onResize(() => sendResize());
      disposers.push(() => dataSub.dispose());
      disposers.push(() => resizeSub.dispose());
      const onWin = () => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
        sendResize();
      };
      window.addEventListener("resize", onWin);
      disposers.push(() => window.removeEventListener("resize", onWin));
      disposers.push(() => term?.dispose());
    })();

    return () => {
      disposed = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* best-effort teardown */
        }
      }
      ws?.close();
    };
  }, [session, name]);

  // Reconnect / exit banner: shown when a session has ended (cleanly, on exit, or on a drop/idle-timeout).
  const ended = session > 0 && (state === "closed" || state === "reconnecting");

  const actions =
    session > 0 ? (
      <Button size="sm" onClick={closeSession} title="close this shell session">
        close
      </Button>
    ) : (
      <Button size="sm" variant="primary" onClick={openShell}>
        open shell
      </Button>
    );

  return (
    <div className="sec">
      <StreamHeader title="shell" state={session === 0 ? "idle" : state} label={session === 0 ? "closed" : undefined} actions={actions} />
      {/* Desktop-first (M5): the terminal wants a real keyboard + width; small viewports get a heads-up
          (CSS-only, shown under 760px) rather than a cramped/broken layout. */}
      <p className="desktop-only-note muted">The terminal is best used on a wider screen with a physical keyboard.</p>
      {error && <div className="err" style={{ marginTop: 8 }}>{error}</div>}
      {session === 0 ? (
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Open an interactive shell into a running pod. Audited; a shell can read this app's env, including write-only secrets.
        </p>
      ) : (
        <>
          <div className="terminal" ref={containerRef} aria-label="terminal" />
          {ended && (
            <div className="stream-banner" style={{ marginTop: 8 }}>
              <span>
                {exit !== null ? `session ended — exit ${exit}` : "session ended — idle timeout or disconnected"}
              </span>
              <Button size="sm" onClick={startSession}>
                reconnect
              </Button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={askAck}
        title="Open a shell into this app"
        body={
          <>
            An interactive shell runs inside <b>{name}</b>&rsquo;s container. It can read the app&rsquo;s full environment,
            including <b>write-only injected secrets</b>. This session is audited. Shown once per app.
          </>
        }
        confirmLabel="open shell"
        onCancel={() => setAskAck(false)}
        onConfirm={ackAndOpen}
      />
    </div>
  );
}
