// `drop db proxy <db>` — the client side of the authenticated psql tunnel (A3). A local TCP listener
// where each accepted connection: (1) fetches a FRESH single-use tunnel ticket over the normal client
// auth, (2) opens a WebSocket upgrade to the control plane's tunnel endpoint (hand-rolled — no `ws`
// dependency — mirroring the server's frame codec), and (3) splices the local socket to the tunnel.
// The control plane authorizes the ticket (per-user `connect` authz) and splices to the database
// in-cluster, so this works on locked-down deployments with no L4 plane and carries real per-user
// authz + audit — unlike a raw `kubectl port-forward`.
//
// Honest about the hops: the local hop (psql → 127.0.0.1 listener) is plain LOOPBACK; the tunnel hop
// (CLI → API) is the WebSocket; and CNPG serves TLS at the database layer, so a client that asks for
// TLS still negotiates it END-TO-END over the tunnel. Connect with `sslmode=disable` for the simplest
// local psql (the loopback + authenticated tunnel is the security boundary), or keep TLS on if you
// want the DB-layer certificate check too.
import * as net from "node:net";
import * as tls from "node:tls";
import type { Socket } from "node:net";
import { FrameDecoder, encodeFrame, encodeClose, newSecWebSocketKey, OPCODE } from "../ws/frames.ts";

/** The auth material the tunnel needs: the API base URL + a bearer (a login session or DROP_TOKEN). */
export interface TunnelSession {
  apiBase: string;
  token: string;
}

/** Fetch a fresh single-use tunnel ticket for `db` (authorized by the caller's `connect` grant). */
async function fetchTicket(session: TunnelSession, db: string): Promise<{ ticket: string; wsPath: string }> {
  const res = await fetch(`${session.apiBase}/v1/databases/${db}/tunnel-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
  });
  const j = (await res.json().catch(() => ({}))) as { ticket?: string; wsPath?: string; error?: string };
  if (!res.ok) throw new Error(j.error ?? `tunnel-ticket: ${res.status}`);
  if (!j.ticket || !j.wsPath) throw new Error("tunnel-ticket: malformed response (no ticket/wsPath)");
  return { ticket: j.ticket, wsPath: j.wsPath };
}

/** Open the WebSocket upgrade against the API and resolve with the raw tunnel socket (+ any early
 *  bytes in `head`). A non-101 response (e.g. an expired ticket → 401, a non-in-cluster API → 501) is
 *  surfaced as an error carrying the server's status + body. */
function openUpgrade(apiBase: string, wsPath: string, ticket: string): Promise<{ socket: Socket; head: Buffer }> {
  const u = new URL(apiBase);
  const isHttps = u.protocol === "https:";
  const port = Number(u.port) || (isHttps ? 443 : 80);
  // Hand-roll the handshake over a raw socket (net for http, TLS for https — verifying the API's
  // certificate) rather than node:http's upgrade path: it mirrors the server's minimal handshake
  // exactly, needs no `ws` dependency, and behaves identically across runtimes.
  const handshake =
    `GET ${wsPath}?ticket=${encodeURIComponent(ticket)} HTTP/1.1\r\n` +
    `Host: ${u.host}\r\n` +
    `Connection: Upgrade\r\n` +
    `Upgrade: websocket\r\n` +
    `Sec-WebSocket-Key: ${newSecWebSocketKey()}\r\n` +
    `Sec-WebSocket-Version: 13\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const socket: Socket = isHttps
      ? tls.connect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ["http/1.1"] })
      : net.connect({ host: u.hostname, port });
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(msg));
    };
    socket.once(isHttps ? "secureConnect" : "connect", () => socket.write(handshake));
    const onData = (d: Buffer) => {
      if (settled) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return; // response headers not fully buffered yet
      const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
      const rest = buf.subarray(i + 4); // any frame bytes the server already sent after the 101
      if (/ 101 /.test(statusLine)) {
        settled = true;
        socket.removeListener("data", onData);
        socket.setNoDelay(true);
        resolve({ socket, head: rest });
      } else {
        fail(`tunnel upgrade rejected: ${statusLine.trim()}${rest.length ? ` — ${rest.toString().trim()}` : ""}`);
      }
    };
    socket.on("data", onData);
    socket.on("error", (e) => fail((e as Error).message));
    socket.on("close", () => fail("tunnel connection closed before upgrade"));
  });
}

/** Splice a local psql socket to the tunnel WebSocket: local bytes → MASKED binary frames (RFC 6455
 *  requires client frames be masked), inbound frames → local bytes. Answers ping, tears down on close. */
function spliceClient(local: Socket, ws: Socket, head: Buffer): void {
  const decoder = new FrameDecoder();
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    if (!ws.destroyed) ws.write(encodeClose(1000, true)); // courteous masked close
    local.destroy();
    ws.destroy();
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
      if (f.payload.length && !local.write(f.payload)) ws.pause();
    }
  };
  ws.on("data", onWs);
  local.on("drain", () => ws.resume());
  local.on("data", (chunk: Buffer) => {
    if (!ws.write(encodeFrame(chunk, { opcode: OPCODE.binary, masked: true }))) local.pause();
  });
  ws.on("drain", () => local.resume());
  local.on("close", done);
  ws.on("close", done);
  local.on("error", done);
  ws.on("error", done);
  if (head && head.length) onWs(head);
}

/** Open ONE tunnel for an accepted local connection: fresh ticket → upgrade → splice. Any bytes the
 *  psql client sends BEFORE the tunnel is spliced (it may open with an SSLRequest / startup packet
 *  immediately on connect, while we're still fetching a ticket + upgrading) are captured and replayed
 *  into the tunnel — a paused accepted socket isn't a reliable buffer across an async gap. */
export async function openTunnel(session: TunnelSession, db: string, local: Socket): Promise<void> {
  const early: Buffer[] = [];
  let localClosed = false;
  const buffer = (d: Buffer) => early.push(d);
  const onEarlyClose = () => (localClosed = true);
  local.on("data", buffer); // switch to flowing so nothing is dropped during setup
  local.once("close", onEarlyClose);
  try {
    const { ticket, wsPath } = await fetchTicket(session, db);
    const { socket, head } = await openUpgrade(session.apiBase, wsPath, ticket);
    local.removeListener("data", buffer);
    local.removeListener("close", onEarlyClose);
    if (localClosed) {
      socket.destroy();
      return;
    }
    // Replay the client's early bytes into the tunnel, THEN hand off to the live splice.
    for (const chunk of early) socket.write(encodeFrame(chunk, { opcode: OPCODE.binary, masked: true }));
    spliceClient(local, socket, head);
  } catch (e) {
    local.removeListener("data", buffer);
    local.removeListener("close", onEarlyClose);
    throw e;
  }
}

export interface DbProxyOptions {
  session: TunnelSession;
  db: string;
  port?: number; // 0 / undefined → an ephemeral port (printed)
  log?: (s: string) => void;
  onError?: (e: Error) => void; // per-connection tunnel failures (surfaced, never fatal to the listener)
}

/** Run the local TCP listener. Each accepted connection rides its own fresh-ticket tunnel. Returns the
 *  bound port + a `close()` for teardown (Ctrl-C). The testable entrypoint — the CLI command is a thin
 *  wrapper that also wires SIGINT + the ready line. */
export async function runDbProxy(opts: DbProxyOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((local) => {
    local.on("error", () => local.destroy());
    openTunnel(opts.session, opts.db, local).catch((e) => {
      opts.onError?.(e as Error);
      local.destroy(); // a failed tunnel closes that one connection; the listener keeps serving
    });
  });
  server.on("error", (e) => opts.onError?.(e as Error));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
