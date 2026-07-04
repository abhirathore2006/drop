// `drop exec <app> [-- cmd…]` — the client side of the authenticated interactive shell (J3). It:
//   (1) fetches a fresh single-use EXEC ticket over the normal client auth (the command is bound to the
//       ticket server-side, so the WS upgrade can't run a different one),
//   (2) opens a WebSocket upgrade to the control plane's exec endpoint (reusing db:proxy's hand-rolled
//       client dial — no `ws` dependency), and
//   (3) bridges the local terminal to the tunnel using the drop-internal exec framing (ws/exec-protocol):
//       local stdin → MASKED binary frames (raw bytes, channel 0 on the far side); inbound binary frames
//       are split by their 1-byte marker into stdout / stderr / the exit code; a TTY's resize (SIGWINCH)
//       becomes a JSON TEXT frame.
//
// TTY posture: when stdin is a TTY we go RAW (`setRawMode(true)`) so keystrokes — including Ctrl-C —
// pass THROUGH to the remote shell unmodified, and forward SIGWINCH as resize frames. There is no
// client-side escape hatch in v1: you leave the session by exiting the remote shell (`exit` / Ctrl-D),
// which ends the process and closes the tunnel. Non-TTY stdin (a pipe) is streamed for scripting.
import type { Socket } from "node:net";
import { FrameDecoder, encodeFrame, encodeClose, OPCODE } from "../ws/frames.ts";
import { EXEC_STREAM, decodeExecChunk, encodeResize } from "../ws/exec-protocol.ts";
import { openUpgrade } from "./db-proxy.ts";
import type { TunnelSession } from "./db-proxy.ts";

/** Fetch a fresh single-use exec ticket for `app`, binding `command` (authorized by `exec`). */
export async function fetchExecTicket(session: TunnelSession, app: string, command: string[]): Promise<{ ticket: string; wsPath: string; command: string[] }> {
  const res = await fetch(`${session.apiBase}/v1/apps/${app}/exec-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const j = (await res.json().catch(() => ({}))) as { ticket?: string; wsPath?: string; command?: string[]; error?: string };
  if (!res.ok) throw new Error(j.error ?? `exec-ticket: ${res.status}`);
  if (!j.ticket || !j.wsPath) throw new Error("exec-ticket: malformed response (no ticket/wsPath)");
  return { ticket: j.ticket, wsPath: j.wsPath, command: j.command ?? command };
}

/** The minimal stdin surface the bridge uses (process.stdin satisfies it; a fake EventEmitter can too). */
export interface ExecStdin {
  on(event: string, cb: (...a: any[]) => void): unknown;
  removeListener(event: string, cb: (...a: any[]) => void): unknown;
  pause?(): unknown;
  resume?(): unknown;
  setRawMode?(v: boolean): unknown;
}

/** The terminal endpoints the bridge drives — injectable so the splice is testable without a real TTY. */
export interface ExecIo {
  stdin: ExecStdin;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  isTTY: boolean;
  /** [cols, rows] for the initial + SIGWINCH resizes (TTY only). */
  size?: () => { cols: number; rows: number };
  /** Register a resize listener (SIGWINCH); returns a disposer. TTY only. */
  onResize?: (cb: () => void) => () => void;
}

/** Splice the local terminal to the exec WebSocket. Resolves with the remote exit code once the tunnel
 *  closes. Masks all client frames (RFC 6455). Pure of process globals — everything comes via `io`. */
export function spliceExec(io: ExecIo, ws: Socket, head: Buffer): Promise<number> {
  return new Promise<number>((resolve) => {
    const decoder = new FrameDecoder();
    let closed = false;
    let exitCode = 0;
    let disposeResize: (() => void) | undefined;

    const done = () => {
      if (closed) return;
      closed = true;
      if (disposeResize) disposeResize();
      io.stdin.removeListener("data", onStdin);
      if (io.isTTY && io.stdin.setRawMode) {
        try {
          io.stdin.setRawMode(false);
        } catch {
          /* stdin already closed */
        }
      }
      io.stdin.pause?.();
      if (!ws.destroyed) ws.write(encodeClose(1000, true)); // courteous masked close
      ws.destroy();
      resolve(exitCode);
    };

    const onWs = (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        return done();
      }
      for (const f of frames) {
        if (f.opcode === OPCODE.close) return done();
        if (f.opcode === OPCODE.ping) {
          if (!ws.destroyed) ws.write(encodeFrame(f.payload, { opcode: OPCODE.pong, masked: true }));
          continue;
        }
        if (f.opcode === OPCODE.pong) continue;
        const { marker, data } = decodeExecChunk(f.payload);
        if (marker === EXEC_STREAM.stdout) io.stdout.write(data);
        else if (marker === EXEC_STREAM.stderr) io.stderr.write(data);
        else if (marker === EXEC_STREAM.exit) exitCode = Number(data.toString("utf8")) || 0;
      }
    };
    ws.on("data", onWs);
    ws.on("close", done);
    ws.on("error", done);

    // Local stdin → masked binary frames (raw bytes).
    const onStdin = (chunk: Buffer) => {
      if (!ws.destroyed) ws.write(encodeFrame(chunk, { opcode: OPCODE.binary, masked: true }));
    };
    if (io.isTTY && io.stdin.setRawMode) {
      try {
        io.stdin.setRawMode(true);
      } catch {
        /* not a real TTY */
      }
    }
    io.stdin.resume?.();
    io.stdin.on("data", onStdin);
    // A piped stdin (non-TTY) ends → half-close by letting the remote see EOF via a courteous close.
    io.stdin.on("end", () => {
      if (!io.isTTY) done();
    });

    // TTY resize: send the initial size, then one frame per SIGWINCH.
    if (io.isTTY && io.size) {
      const sendSize = () => {
        const { cols, rows } = io.size!();
        if (!ws.destroyed) ws.write(encodeFrame(Buffer.from(encodeResize(cols, rows)), { opcode: OPCODE.text, masked: true }));
      };
      sendSize();
      if (io.onResize) disposeResize = io.onResize(sendSize);
    }

    if (head && head.length) onWs(head);
  });
}

export interface RunExecOptions {
  session: TunnelSession;
  app: string;
  command: string[];
  /** Overridable for tests; defaults to the real process streams. */
  io?: ExecIo;
}

/** Fetch a ticket, dial the exec WS, splice the terminal, and resolve with the remote exit code. */
export async function runExec(opts: RunExecOptions): Promise<number> {
  const io = opts.io ?? processIo();
  const { ticket, wsPath } = await fetchExecTicket(opts.session, opts.app, opts.command);
  const { socket, head } = await openUpgrade(opts.session.apiBase, wsPath, ticket);
  return spliceExec(io, socket, head);
}

/** The default terminal wiring over the real process (kept out of spliceExec so that stays testable). */
function processIo(): ExecIo {
  const isTTY = !!process.stdin.isTTY && !!process.stdout.isTTY;
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY,
    size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    onResize: (cb) => {
      process.stdout.on("resize", cb);
      return () => process.stdout.removeListener("resize", cb);
    },
  };
}
