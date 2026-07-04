// The `drop exec` WebSocket bridge — server side (J3). Like the A3 db:proxy tunnel this is a Node-level
// `server.on('upgrade')` handler (attached via the route-table dispatcher in bin/api.ts), NOT a Hono
// route: a WebSocket upgrade never reaches Hono, so the bridge runs on the raw socket and the API IS the
// WebSocket server (it emits the 101 itself).
//
// Two protocols meet here and the bridge TRANSLATES between them:
//   • CLI ↔ API leg  — the drop-internal framing (src/ws/exec-protocol.ts): client BINARY frames are
//     raw stdin; a client TEXT frame is a JSON `{cols,rows}` resize; server BINARY frames carry a
//     1-byte stream marker (1=stdout, 2=stderr, 3=exit-code) so one channel splits back to the CLI.
//   • API ↔ kubelet leg — the kube v4.channel.k8s.io session (src/kube/exec.ts) opened by KubeClient.
//
// Auth model (identical posture to db:proxy): the single-use `?ticket=` IS the credential (the upgrade
// runs outside Hono's bearer middleware). The ticket was minted by an authenticated `can("exec")` POST,
// is bound to (user, app, COMMAND), single-use, and 60s-lived. Crucially the command comes from the
// REDEEMED TICKET, never from the upgrade — a redeemed exec upgrade cannot escalate to a different
// command than the one authorized at issuance. `app.exec` is audited AT REDEMPTION (the session), WITH
// the command, mirroring db.tunnel.open.
import type { Socket } from "node:net";
import type { MetaStore } from "../metastore/store.ts";
import type { AuditEntry } from "../audit/store.ts";
import type { TunnelTicketStore } from "../tokens/tunnel-tickets.ts";
import type { KubeClient } from "../kube/types.ts";
import { FrameDecoder, encodeFrame, encodeClose, acceptKey, OPCODE } from "../ws/frames.ts";
import { EXEC_STREAM, encodeExecChunk, parseResize } from "../ws/exec-protocol.ts";
import { exitCodeFromStatus, type KubeExecSession } from "../kube/exec.ts";
import { writeHttpError } from "./db-tunnel.ts";

export interface ExecBridgeOptions {
  meta: MetaStore;
  tickets: TunnelTicketStore;
  /** The cluster client used to open the exec stream; undefined when compute is off (→ 501 at redeem). */
  kube?: KubeClient;
  /** Append the `app.exec` audit event (best-effort; a failed audit never fails the session). */
  audit?: (e: AuditEntry) => void;
  /** Idle timeout in ms — a session with no bytes either way for this long is torn down (default 15 min). */
  idleTimeoutMs?: number;
  /** Per-user concurrent-exec cap, enforced at redemption via an in-process counter (default 3). */
  maxExecPerUser?: number;
  /** Called once when a session closes, with final byte counts — the G2-shaped metrics seam. */
  onClose?: (stats: ExecStats) => void;
}

export interface ExecStats {
  email: string;
  app: string;
  command: string[];
  bytesIn: number; // client → remote (stdin)
  bytesOut: number; // remote → client (stdout+stderr)
  reason: string; // client | remote | idle | protocol | error
}

const EXEC_PATH = /^\/v1\/apps\/([^/]+)\/exec$/;

/** Build the exec-branch of the `server.on('upgrade')` dispatcher. */
export function createExecHandler(opts: ExecBridgeOptions): (req: any, socket: Socket, head: Buffer) => void {
  const idleMs = opts.idleTimeoutMs ?? 15 * 60_000;
  const maxPerUser = opts.maxExecPerUser ?? 3;
  // Live concurrent-exec counts, keyed by user email. In-process — correct for the single-API-instance
  // reality; a multi-replica deployment would want a shared counter (same caveat the db:proxy cap notes).
  const perUser = new Map<string, number>();

  /** Bidirectional pump: CLI WS frames <-> the kube exec session. */
  function bridge(client: Socket, exec: KubeExecSession, email: string, app: string, command: string[], head: Buffer, release: () => void): void {
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
      if (!client.destroyed) client.write(encodeClose());
      client.destroy();
      exec.close();
      release();
      opts.onClose?.({ email, app, command, bytesIn, bytesOut, reason });
    };
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => done("idle"), idleMs);
    };

    // Remote → client: stdout/stderr framed with a 1-byte marker; the exit status becomes an exit frame.
    exec.onData((stream, data) => {
      touch();
      bytesOut += data.length;
      const marker = stream === "stderr" ? EXEC_STREAM.stderr : EXEC_STREAM.stdout;
      if (!client.destroyed) client.write(encodeFrame(encodeExecChunk(marker, data), { opcode: OPCODE.binary }));
    });
    exec.onError((statusJson) => {
      // The process exited: forward its exit code as an exit frame so the CLI mirrors it, then close.
      const code = exitCodeFromStatus(statusJson) ?? 0;
      if (!client.destroyed) client.write(encodeFrame(encodeExecChunk(EXEC_STREAM.exit, Buffer.from(String(code))), { opcode: OPCODE.binary }));
    });
    exec.onClose(() => done("remote"));

    // Client → remote: decode masked WS frames; BINARY = stdin bytes → channel 0; TEXT = JSON resize.
    const onClient = (chunk: Buffer) => {
      touch();
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        return done("protocol");
      }
      for (const f of frames) {
        if (f.opcode === OPCODE.close) return done("client");
        if (f.opcode === OPCODE.ping) {
          if (!client.destroyed) client.write(encodeFrame(f.payload, { opcode: OPCODE.pong }));
          continue;
        }
        if (f.opcode === OPCODE.pong) continue;
        if (f.opcode === OPCODE.text) {
          const resize = parseResize(f.payload.toString("utf8"));
          if (resize) exec.resize(resize.cols, resize.rows);
          continue;
        }
        // continuation / binary → raw stdin bytes.
        bytesIn += f.payload.length;
        if (f.payload.length) exec.write(f.payload);
      }
    };
    client.on("data", onClient);
    client.on("close", () => done("client"));
    client.on("error", () => done("error"));
    touch();
    // Bytes that arrived in the upgrade `head` are frames the client sent before the 101 was processed.
    if (head && head.length) onClient(head);
  }

  return (req, socket: Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());

    const url = req.url ?? "/";
    const qIdx = url.indexOf("?");
    const path = qIdx === -1 ? url : url.slice(0, qIdx);
    const match = EXEC_PATH.exec(path);
    if (!match) return writeHttpError(socket, 404, "not a websocket endpoint");
    if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") return writeHttpError(socket, 501, "unsupported upgrade");
    const wsKey = req.headers["sec-websocket-key"] as string | undefined;
    if (!wsKey) return writeHttpError(socket, 400, "missing Sec-WebSocket-Key");
    const accept = acceptKey(wsKey);

    const appName = decodeURIComponent(match[1]!);
    const params = new URLSearchParams(qIdx === -1 ? "" : url.slice(qIdx + 1));
    const ticket = params.get("ticket") ?? "";
    if (!ticket) return writeHttpError(socket, 401, "exec ticket required (?ticket=…)");

    void run().catch(() => {
      if (!socket.destroyed) writeHttpError(socket, 502, "bad gateway");
    });

    async function run(): Promise<void> {
      // Redeem the single-use EXEC ticket (unexpired, right app, kind=exec, not already used) — this IS
      // the authz for the upgrade; a bad/expired/replayed/wrong-kind ticket is a clean 401.
      const redeemed = await opts.tickets.redeem(ticket, appName, "exec");
      if (!redeemed) return void writeHttpError(socket, 401, "invalid, expired, or already-used exec ticket");

      const site = await opts.meta.getSitePlain(appName);
      if (!site) return void writeHttpError(socket, 404, "no such app"); // vanished between issue + redeem
      if (site.type !== "app") return void writeHttpError(socket, 409, `exec applies to apps only, not a ${site.type}`);
      if (!opts.kube) return void writeHttpError(socket, 501, "compute is not enabled on this instance");

      // Per-user concurrent-exec cap (in-process counter; enforced at redemption).
      const active = perUser.get(redeemed.email) ?? 0;
      if (active >= maxPerUser) return void writeHttpError(socket, 503, `too many concurrent exec sessions (max ${maxPerUser})`);
      perUser.set(redeemed.email, active + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const n = (perUser.get(redeemed.email) ?? 1) - 1;
        if (n <= 0) perUser.delete(redeemed.email);
        else perUser.set(redeemed.email, n);
      };

      // The command comes from the REDEEMED TICKET (bound at issuance) — never the upgrade. Default to a
      // shell if a ticket somehow carries none (belt-and-suspenders; the route always stores one).
      const command = redeemed.command && redeemed.command.length ? redeemed.command : ["/bin/sh"];

      let exec;
      try {
        exec = await opts.kube.openExec(site.namespace, appName, command, { tty: true });
      } catch {
        release();
        return void writeHttpError(socket, 502, "exec failed to start");
      }
      if (!exec) {
        release();
        return void writeHttpError(socket, 502, "no ready pod to exec into (is the app running?)");
      }

      // Emit the 101 ourselves (the API is the WS server) and start bridging.
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // Audit the session at redemption — WITH the command (the security-relevant detail).
      opts.audit?.({
        actor: redeemed.email,
        action: "app.exec",
        target: appName,
        targetType: "app",
        orgId: site.orgId,
        detail: { command },
      });
      bridge(socket, exec, redeemed.email, appName, command, head, release);
    }
  };
}
