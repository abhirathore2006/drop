// Kubernetes pod `exec` over WebSocket — the `v4.channel.k8s.io` streaming subprotocol spoken directly
// against the kube API server over the SAME TLS transport the KubeApiClient already uses (client-cert
// or bearer from the kubeconfig), so the self-contained esbuild bundle stays free of
// @kubernetes/client-node (ADR-0005). This is the cluster leg of J3's `drop exec`.
//
// Transport: TLS to the API server, then a hand-rolled RFC 6455 upgrade (mirroring src/cli/db-proxy.ts's
// client dial) carrying `Sec-WebSocket-Protocol: v4.channel.k8s.io`. We are the CLIENT of the API
// server, so our frames are MASKED and the server's are not (the shared codec's `masked` flag).
//
// Channel protocol (v4.channel.k8s.io): every WebSocket binary message is `[channel byte, ...payload]`.
//   0 stdin  (client→server)      1 stdout (server→client)   2 stderr (server→client)
//   3 error/status (server→client — a metav1.Status JSON emitted at process exit, carrying the exit
//     code in details.causes[reason=ExitCode].message)   4 resize (client→server, JSON {Width,Height}).
// Each exec message is a single (unfragmented) frame whose payload is one channel slice, so — exactly
// like the db:proxy splice — there is no logical-message reassembly: one frame in, one channel out.
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";
import { FrameDecoder, encodeFrame, encodeClose, newSecWebSocketKey, OPCODE } from "../ws/frames.ts";

/** v4.channel.k8s.io channel numbers (the first byte of each binary message's payload). */
export const EXEC_CHANNEL = { stdin: 0, stdout: 1, stderr: 2, error: 3, resize: 4 } as const;
/** The subprotocol we negotiate. v4 is universally served; v5 adds a half-close channel we don't need. */
export const KUBE_EXEC_SUBPROTOCOL = "v4.channel.k8s.io";

// ---- pure channel framing (unit-tested without a cluster) --------------------------------------

/** Prefix raw stdin bytes with the stdin channel byte (channel 0). Pure. */
export function encodeStdinChannel(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([EXEC_CHANNEL.stdin]), data]);
}

/** The channel-4 resize control message: `[4]` + JSON `{"Width":cols,"Height":rows}`. Pure. */
export function encodeResizeChannel(cols: number, rows: number): Buffer {
  return Buffer.concat([Buffer.from([EXEC_CHANNEL.resize]), Buffer.from(JSON.stringify({ Width: cols, Height: rows }))]);
}

/** Split a server→client channel message into {channel, data}. An empty payload → channel -1. Pure. */
export function parseChannelFrame(payload: Buffer): { channel: number; data: Buffer } {
  if (payload.length === 0) return { channel: -1, data: Buffer.alloc(0) };
  return { channel: payload[0]!, data: payload.subarray(1) };
}

/** Extract the process exit code from a channel-3 metav1.Status JSON: 0 on Success, the ExitCode cause
 *  otherwise, or null when it isn't a recognizable status. Pure. */
export function exitCodeFromStatus(statusJson: string): number | null {
  try {
    const s = JSON.parse(statusJson) as {
      status?: string;
      details?: { causes?: { reason?: string; message?: string }[] };
    };
    if (s.status === "Success") return 0;
    const cause = (s.details?.causes ?? []).find((c) => c.reason === "ExitCode");
    if (cause?.message != null) {
      const n = parseInt(cause.message, 10);
      return Number.isNaN(n) ? null : n;
    }
    // A Failure without an ExitCode cause (e.g. "command terminated"): non-zero, code unknown → 1.
    if (s.status === "Failure") return 1;
    return null;
  } catch {
    return null;
  }
}

// ---- live session ------------------------------------------------------------------------------

/** A live kube exec stream, abstracted so the API bridge is testable with a FakeKube double. Bytes in
 *  go to stdin (channel 0); stdout/stderr/error/close come back via the registered callbacks. */
export interface KubeExecSession {
  /** Write raw stdin bytes to the remote process (channel 0). */
  write(data: Buffer): void;
  /** Send a terminal resize (channel 4). */
  resize(cols: number, rows: number): void;
  /** stdout (channel 1) / stderr (channel 2) bytes from the remote process. */
  onData(cb: (stream: "stdout" | "stderr", data: Buffer) => void): void;
  /** The channel-3 status JSON emitted at exit (raw string — the bridge maps it to an exit code). */
  onError(cb: (statusJson: string) => void): void;
  /** The stream ended (remote exit, socket close, or a local `close()`). Fires exactly once. */
  onClose(cb: (reason: string) => void): void;
  /** Tear the stream down (client hang-up / idle / cap). Idempotent. */
  close(): void;
}

/** The kube connection material the transport needs — a subset of the KubeApiClient's `conn`. */
export interface KubeExecConn {
  server: string; // https://host:port
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  token?: string;
}

/** Open an exec WebSocket to the API server at `path` (a fully-formed `/api/v1/namespaces/…/exec?…`),
 *  resolving with a live session once the 101 lands. Rejects on a non-101 upgrade or a transport error. */
export function openKubeExecStream(conn: KubeExecConn, path: string): Promise<KubeExecSession> {
  const u = new URL(conn.server + path);
  const port = Number(u.port) || 443;
  const handshake =
    `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
    `Host: ${u.host}\r\n` +
    `Connection: Upgrade\r\n` +
    `Upgrade: websocket\r\n` +
    `Sec-WebSocket-Key: ${newSecWebSocketKey()}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `Sec-WebSocket-Protocol: ${KUBE_EXEC_SUBPROTOCOL}\r\n` +
    (conn.token ? `Authorization: Bearer ${conn.token}\r\n` : "") +
    `\r\n`;
  return new Promise((resolve, reject) => {
    // The API server always speaks TLS (client-cert or SA-token auth); reuse the kubeconfig CA + client
    // cert/key exactly as KubeApiClient.call does. `ALPNProtocols: http/1.1` keeps the upgrade on HTTP/1.
    const socket = tlsConnect({
      host: u.hostname,
      port,
      servername: u.hostname,
      ca: conn.ca,
      cert: conn.cert,
      key: conn.key,
      ALPNProtocols: ["http/1.1"],
    });
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(msg));
    };
    socket.once("secureConnect", () => socket.write(handshake));
    const onData = (d: Buffer) => {
      if (settled) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return; // response headers not fully buffered yet
      const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
      const rest = buf.subarray(i + 4); // any frame bytes the server sent right after the 101
      if (/ 101 /.test(statusLine)) {
        settled = true;
        socket.removeListener("data", onData);
        socket.setNoDelay(true);
        resolve(makeSession(socket, rest));
      } else {
        fail(`kube exec upgrade rejected: ${statusLine.trim()}${rest.length ? ` — ${rest.toString().trim().slice(0, 200)}` : ""}`);
      }
    };
    socket.on("data", onData);
    socket.on("error", (e) => fail((e as Error).message));
    socket.on("close", () => fail("kube exec connection closed before upgrade"));
  });
}

/** Wrap a post-101 socket in a KubeExecSession: decode the server's unmasked channel frames, mask ours. */
function makeSession(socket: Socket, head: Buffer): KubeExecSession {
  const decoder = new FrameDecoder();
  let dataCb: ((stream: "stdout" | "stderr", data: Buffer) => void) | undefined;
  let errorCb: ((statusJson: string) => void) | undefined;
  let closeCb: ((reason: string) => void) | undefined;
  let closed = false;

  const done = (reason: string) => {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) {
      try {
        socket.write(encodeClose(1000, true)); // courteous masked close (client → server)
      } catch {
        /* socket already gone */
      }
    }
    socket.destroy();
    closeCb?.(reason);
  };

  const onFrames = (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      return done("protocol"); // oversized / garbage frame
    }
    for (const f of frames) {
      if (f.opcode === OPCODE.close) return done("remote");
      if (f.opcode === OPCODE.ping) {
        if (!socket.destroyed) socket.write(encodeFrame(f.payload, { opcode: OPCODE.pong, masked: true }));
        continue;
      }
      if (f.opcode === OPCODE.pong) continue;
      const { channel, data } = parseChannelFrame(f.payload);
      if (channel === EXEC_CHANNEL.stdout) dataCb?.("stdout", data);
      else if (channel === EXEC_CHANNEL.stderr) dataCb?.("stderr", data);
      else if (channel === EXEC_CHANNEL.error) errorCb?.(data.toString("utf8"));
      // channel 0/4 are client→server only; anything else is ignored.
    }
  };
  socket.on("data", onFrames);
  socket.on("close", () => done("closed"));
  socket.on("error", () => done("error"));
  if (head && head.length) onFrames(head);

  return {
    write(data: Buffer) {
      if (!closed && !socket.destroyed && data.length) {
        socket.write(encodeFrame(encodeStdinChannel(data), { opcode: OPCODE.binary, masked: true }));
      }
    },
    resize(cols: number, rows: number) {
      if (!closed && !socket.destroyed) {
        socket.write(encodeFrame(encodeResizeChannel(cols, rows), { opcode: OPCODE.binary, masked: true }));
      }
    },
    onData(cb) {
      dataCb = cb;
    },
    onError(cb) {
      errorCb = cb;
    },
    onClose(cb) {
      closeCb = cb;
    },
    close() {
      done("client");
    },
  };
}
