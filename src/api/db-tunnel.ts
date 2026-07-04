// The `db:proxy` WebSocket tunnel — server side (A3). This is a Node-level `server.on('upgrade')`
// handler attached in bin/api.ts, NOT a Hono route: a WebSocket upgrade never reaches Hono, so the
// splice runs on the raw socket. Unlike the edge WS proxy (a transparent byte tunnel that forwards the
// APP's 101), HERE the API IS the WebSocket server — it emits the 101 itself, then frames the
// database's raw TCP bytes into binary WS messages (and unframes the client's masked frames back into
// TCP bytes). It handles EVERY upgrade the API receives: only `/v1/databases/:name/tunnel` is served;
// any other path is rejected, so attaching this listener doesn't accidentally open a WS surface
// elsewhere (before A3 the API had no upgrade listener, so all upgrades were dropped).
//
// Auth model: the single-use ticket in `?ticket=` IS the credential (the upgrade runs outside Hono's
// bearer-auth middleware). The ticket was minted by an authenticated, `connect`-authorized POST, is
// bound to (user, database), single-use, and 60s-lived — so a redeemed upgrade is already authorized
// and replay-proof. `db.tunnel.open` is audited at REDEMPTION (here), not at issuance: issuing a
// ticket can be speculative (the CLI may fetch one per accepted local connection and never dial), so
// the connection — the security-relevant event — is what we record.
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import type { MetaStore } from "../metastore/store.ts";
import type { Site } from "../metastore/types.ts";
import type { AuditEntry } from "../audit/store.ts";
import type { TunnelTicketStore } from "../tokens/tunnel-tickets.ts";
import { FrameDecoder, encodeFrame, encodeClose, acceptKey, OPCODE } from "../ws/frames.ts";

/** The in-cluster dial target for a database (`<db>-rw.<ns>.svc:5432`), or null when unreachable. */
export interface DbTunnelTarget {
  host: string;
  port: number;
}

export interface DbTunnelOptions {
  meta: MetaStore;
  tickets: TunnelTicketStore;
  /** Resolve the TCP dial target for a database site, or null when the tunnel CANNOT be served from
   *  THIS process — the local posture where the API runs OUTSIDE the cluster and has no route to the DB
   *  Service (→ 501). In-cluster (DROP_TUNNEL_DIRECT=1) this returns the `<db>-rw.<ns>.svc` address. */
  resolveTarget: (site: Site) => DbTunnelTarget | null;
  /** Append the `db.tunnel.open` audit event (best-effort; a failed audit never fails the tunnel). */
  audit?: (e: AuditEntry) => void;
  /** Idle timeout in ms — a tunnel with no bytes either way for this long has both sockets destroyed. */
  idleTimeoutMs?: number;
  /** Per-user concurrent-tunnel cap, enforced at redemption via an in-process counter (default 5). */
  maxTunnelsPerUser?: number;
  /** Called once when a spliced tunnel closes, with final byte counts — the G2-shaped metrics seam. */
  onClose?: (stats: DbTunnelStats) => void;
  /** TCP connect budget for the DB dial (ms, default 10s). */
  dialTimeoutMs?: number;
}

export interface DbTunnelStats {
  email: string;
  db: string;
  bytesIn: number; // client → database
  bytesOut: number; // database → client
  reason: string; // client | database | idle | protocol | error
}

const REASON: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  409: "Conflict",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** Write a plain HTTP error to the raw upgrade socket and close it — the client never sees a 101, so a
 *  rejected tunnel never half-opens (identical posture to the edge WS proxy's pre-upgrade rejection). */
function writeHttpError(socket: Socket, status: number, body: string): void {
  if (socket.destroyed) return;
  const msg =
    `HTTP/1.1 ${status} ${REASON[status] ?? "Error"}\r\n` +
    `content-type: text/plain; charset=utf-8\r\n` +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    `connection: close\r\n\r\n${body}`;
  socket.end(msg);
}

const TUNNEL_PATH = /^\/v1\/databases\/([^/]+)\/tunnel$/;

/** Build the `server.on('upgrade')` handler for the `db:proxy` tunnel. */
export function createDbTunnelHandler(opts: DbTunnelOptions): (req: any, socket: Socket, head: Buffer) => void {
  const idleMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const maxPerUser = opts.maxTunnelsPerUser ?? 5;
  const dialTimeoutMs = opts.dialTimeoutMs ?? 10_000;
  // Live concurrent-tunnel counts, keyed by user email. In-process: correct for the single-API-instance
  // local reality (the only place db:proxy runs today); a multi-replica deployment would want a shared
  // counter (a metastore row / Redis) — noted, deferred with the same posture as the password-rotation
  // lock and the tunnel-ticket single-use latch's caveat.
  const perUser = new Map<string, number>();

  function dial(target: DbTunnelTarget): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const s = netConnect({ host: target.host, port: target.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("dial timeout"));
      }, dialTimeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        s.setNoDelay(true);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /** Bidirectional pump: WS frames (client) <-> raw TCP bytes (database). Client frames are unframed
   *  into DB bytes; DB bytes are framed into unmasked binary WS messages. Idle timeout + byte counting
   *  live here (one place), and a control frame (close/ping) is handled inline. */
  function splice(client: Socket, upstream: Socket, email: string, db: string, head: Buffer, release: () => void): void {
    client.setNoDelay(true);
    const decoder = new FrameDecoder();
    let bytesIn = 0;
    let bytesOut = 0;
    let closed = false;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const done = (reason: string) => {
      if (closed) return;
      closed = true;
      if (idle) clearTimeout(idle);
      // Best-effort courteous close to the client (ignored if the socket is already gone).
      if (!client.destroyed) client.write(encodeClose());
      client.destroy();
      upstream.destroy();
      release();
      opts.onClose?.({ email, db, bytesIn, bytesOut, reason });
    };
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => done("idle"), idleMs);
    };

    // Client → database: decode masked WS frames, forward data payloads, answer control frames.
    const onClient = (chunk: Buffer) => {
      touch();
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        return done("protocol"); // oversized/garbage frame
      }
      for (const f of frames) {
        if (f.opcode === OPCODE.close) return done("client");
        if (f.opcode === OPCODE.ping) {
          if (!client.destroyed) client.write(encodeFrame(f.payload, { opcode: OPCODE.pong })); // server pong: unmasked
          continue;
        }
        if (f.opcode === OPCODE.pong) continue;
        // continuation / text / binary → the payload is a slice of the psql TCP stream.
        bytesIn += f.payload.length;
        if (f.payload.length && !upstream.write(f.payload)) client.pause();
      }
    };
    client.on("data", onClient);
    upstream.on("drain", () => client.resume());

    // Database → client: frame raw bytes into unmasked binary WS messages.
    upstream.on("data", (chunk: Buffer) => {
      touch();
      bytesOut += chunk.length;
      if (!client.write(encodeFrame(chunk, { opcode: OPCODE.binary }))) upstream.pause();
    });
    client.on("drain", () => upstream.resume());

    client.on("close", () => done("client"));
    upstream.on("close", () => done("database"));
    client.on("error", () => done("error"));
    upstream.on("error", () => done("error"));
    touch();
    // Any bytes that arrived in the upgrade `head` are WS frames the client sent before we processed
    // the 101 — feed them through the same path.
    if (head && head.length) onClient(head);
  }

  return (req, socket: Socket, head: Buffer) => {
    // A raw socket error before we splice must never crash the process (a shared-process DoS).
    socket.on("error", () => socket.destroy());

    const url = req.url ?? "/";
    const qIdx = url.indexOf("?");
    const path = qIdx === -1 ? url : url.slice(0, qIdx);
    const match = TUNNEL_PATH.exec(path);
    // Every non-tunnel upgrade is refused — attaching this listener must not open a WS surface elsewhere.
    if (!match) return writeHttpError(socket, 404, "not a websocket endpoint");
    if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") return writeHttpError(socket, 501, "unsupported upgrade");
    const wsKey = req.headers["sec-websocket-key"] as string | undefined;
    if (!wsKey) return writeHttpError(socket, 400, "missing Sec-WebSocket-Key");
    const accept = acceptKey(wsKey); // narrowed here (top level) — the nested run() closure can't re-narrow

    const dbName = decodeURIComponent(match[1]!);
    const params = new URLSearchParams(qIdx === -1 ? "" : url.slice(qIdx + 1));
    const ticket = params.get("ticket") ?? "";
    if (!ticket) return writeHttpError(socket, 401, "tunnel ticket required (?ticket=…)");

    void run().catch(() => {
      if (!socket.destroyed) writeHttpError(socket, 502, "bad gateway");
    });

    async function run(): Promise<void> {
      // Redeem the single-use ticket (unexpired, right database, not already used) — this IS the authz
      // for the upgrade; a bad/expired/replayed ticket is a clean 401.
      const redeemed = await opts.tickets.redeem(ticket, dbName);
      if (!redeemed) return void writeHttpError(socket, 401, "invalid, expired, or already-used tunnel ticket");

      const site = await opts.meta.getSitePlain(dbName);
      if (!site || site.type !== "database") return void writeHttpError(socket, 404, "no such database"); // DB vanished between issue + redeem

      const target = opts.resolveTarget(site);
      if (!target) {
        return void writeHttpError(
          socket,
          501,
          "tunnel requires an in-cluster API (this API runs outside the cluster; set DROP_TUNNEL_DIRECT=1 on an in-cluster deployment)",
        );
      }

      // Per-user concurrent-tunnel cap (in-process counter; enforced at redemption).
      const active = perUser.get(redeemed.email) ?? 0;
      if (active >= maxPerUser) return void writeHttpError(socket, 503, `too many concurrent tunnels (max ${maxPerUser})`);
      perUser.set(redeemed.email, active + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const n = (perUser.get(redeemed.email) ?? 1) - 1;
        if (n <= 0) perUser.delete(redeemed.email);
        else perUser.set(redeemed.email, n);
      };

      let upstream: Socket;
      try {
        upstream = await dial(target);
      } catch {
        release();
        return void writeHttpError(socket, 502, "database unavailable");
      }

      // Emit the 101 ourselves (the API is the WS server) and start splicing.
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // Audit the OPEN at redemption — the connection, not the (possibly speculative) ticket issuance.
      opts.audit?.({
        actor: redeemed.email,
        action: "db.tunnel.open",
        target: dbName,
        targetType: "database",
        orgId: site.orgId,
        detail: { target: `${target.host}:${target.port}` },
      });
      // Byte totals are emitted via onClose in splice (the G2-shaped metrics seam, one place).
      splice(socket, upstream, redeemed.email, dbName, head, release);
    }
  };
}
