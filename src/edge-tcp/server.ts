import { connect as netConnect, createServer } from "node:net";
import type { Server, Socket, AddressInfo } from "node:net";
import type { TcpRouteSource } from "./route-source.ts";
import { extractSni, MAX_CLIENT_HELLO } from "./sni.ts";
import { PgPreamble, REPLY_WILLING } from "./pg-preamble.ts";

/** Protocol spoken on a shared (well-known) port. `postgres` runs the libpq SSL preamble
 *  before the SNI peek; `tls-sni` peeks the ClientHello directly (TLS Redis, MQTT-over-TLS…). */
export type SharedProtocol = "tls-sni" | "postgres";

export interface SharedPortSpec {
  port: number;
  protocol: SharedProtocol;
}

export interface EdgeTcpServerOptions {
  /** Where connections resolve — injected (A2b swaps the static source for a metastore one). */
  source: TcpRouteSource;
  /** Shared protocol ports (SNI / PG preamble routing). */
  sharedPorts: SharedPortSpec[];
  /** Dynamic per-workload ports (routed by port number alone — no protocol parsing). */
  dynamicPorts?: number[];
  /** Idle timeout in ms — a spliced connection with no bytes either way this long has BOTH
   *  sockets destroyed (default 5 min). Mirrors the WS proxy's idle handling. */
  idleTimeoutMs?: number;
  /** Per-workload concurrent-connection cap (default 100). Keyed by `TcpTarget.workload`. */
  maxConnsPerWorkload?: number;
  /** Time budget for the pre-splice handshake (preamble + SNI peek + upstream dial). A slow or
   *  silent peer is dropped rather than pinning a listener slot (default 10 s). */
  handshakeTimeoutMs?: number;
  now?: () => number;
  /** Called once when a spliced connection closes, with the final byte counts — the G2 metrics
   *  seam, same shape as the WS proxy's `onClose`. Only fires for connections that reached the
   *  splice (a rejected/unresolved connection just closes). */
  onClose?: (stats: TcpConnStats) => void;
}

export interface TcpConnStats {
  /** The resolved workload (cap key + attribution). */
  workload: string;
  bytesIn: number; // client → upstream
  bytesOut: number; // upstream → client
  durationMs: number;
  reason: string; // client | upstream | idle | error
}

/** What each listener actually bound to — the real port matters when tests listen on 0. */
export interface ListenerInfo {
  /** The port as configured (0 in tests). */
  configuredPort: number;
  /** The actual bound port. */
  port: number;
  kind: SharedProtocol | "dynamic";
}

const DEFAULTS = {
  idleTimeoutMs: 5 * 60_000,
  maxConnsPerWorkload: 100,
  handshakeTimeoutMs: 10_000,
};

/** Build the in-cluster L4 router: one `net.Server` per shared + dynamic port, each running
 *  the appropriate route path, then splicing to the resolved upstream with a per-connection
 *  idle timeout, a per-workload concurrent cap, and byte counting surfaced via `onClose`. */
export function createEdgeTcpServer(opts: EdgeTcpServerOptions): {
  listen: () => Promise<ListenerInfo[]>;
  close: () => Promise<void>;
  addresses: () => ListenerInfo[];
} {
  const now = opts.now ?? (() => Date.now());
  const idleMs = opts.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
  const maxConns = opts.maxConnsPerWorkload ?? DEFAULTS.maxConnsPerWorkload;
  const handshakeMs = opts.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs;

  // Live per-workload concurrent-connection counts (the cap key is TcpTarget.workload).
  const perWorkload = new Map<string, number>();

  function tryAcquire(workload: string): boolean {
    const n = perWorkload.get(workload) ?? 0;
    if (n >= maxConns) return false;
    perWorkload.set(workload, n + 1);
    return true;
  }
  function releaser(workload: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (perWorkload.get(workload) ?? 1) - 1;
      if (n <= 0) perWorkload.delete(workload);
      else perWorkload.set(workload, n);
    };
  }

  /** A single TCP connect, resolving once the socket is open (mirrors ws-proxy's `dial`). */
  function dial(host: string, port: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const s = netConnect({ host, port });
      s.once("connect", () => {
        s.setNoDelay(true);
        resolve(s);
      });
      s.once("error", reject);
    });
  }

  /** Bidirectional byte pump with backpressure, idle timeout, and byte counting — the ONE
   *  place accounting lives, so `onClose` stays a faithful counter (same shape as ws-proxy).
   *  `seedIn` seeds bytesIn with client bytes already flushed upstream (the buffered
   *  ClientHello); `start` is the connection-open time so `durationMs` spans the whole life. */
  function splice(client: Socket, upstream: Socket, workload: string, seedIn: number, start: number, release: () => void): void {
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    let bytesIn = seedIn;
    let bytesOut = 0;
    let closed = false;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const done = (reason: string) => {
      if (closed) return;
      closed = true;
      if (idle) clearTimeout(idle);
      client.destroy();
      upstream.destroy();
      release();
      opts.onClose?.({ workload, bytesIn, bytesOut, durationMs: now() - start, reason });
    };
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => done("idle"), idleMs);
    };

    client.on("data", (chunk: Buffer) => {
      bytesIn += chunk.length;
      touch();
      if (!upstream.write(chunk)) client.pause();
    });
    upstream.on("drain", () => client.resume());
    upstream.on("data", (chunk: Buffer) => {
      bytesOut += chunk.length;
      touch();
      if (!client.write(chunk)) upstream.pause();
    });
    client.on("drain", () => upstream.resume());

    client.on("close", () => done("client"));
    upstream.on("close", () => done("upstream"));
    client.on("error", () => done("error"));
    upstream.on("error", () => done("error"));
    touch();
    // Resume both: the upstream may be paused (fresh dial, no reader yet); the client stays
    // flowing (its buffering listener was swapped for the pipe one in the same tick).
    client.resume();
    upstream.resume();
  }

  /** Read the upstream's single-byte SSL reply ('S' willing / 'N' unwilling), preserving any
   *  bytes that follow (unshifted so the splice picks them up — normally none, as the server
   *  waits for the ClientHello after 'S'). */
  function readUpstreamSslReply(upstream: Socket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const onData = (d: Buffer) => {
        if (d.length === 0) return;
        cleanup();
        if (d.length > 1) upstream.unshift(d.subarray(1));
        resolve(String.fromCharCode(d[0]!));
      };
      const onErr = (e: Error) => {
        cleanup();
        reject(e);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("upstream closed during SSL negotiation"));
      };
      const cleanup = () => {
        upstream.removeListener("data", onData);
        upstream.removeListener("error", onErr);
        upstream.removeListener("close", onClose);
        upstream.pause(); // hold until the splice re-attaches + resumes (no data lost in the gap)
      };
      upstream.on("data", onData);
      upstream.on("error", onErr);
      upstream.on("close", onClose);
    });
  }

  /** SNI / PG-preamble path (shared ports). A single client `data` listener buffers from the
   *  first byte (a socket without a listener drops early data), the state machine peeks the
   *  preamble + ClientHello, then — once the upstream is dialed — the whole buffer is flushed
   *  verbatim and the connection becomes a transparent splice. */
  function handleShared(client: Socket, protocol: SharedProtocol): void {
    const start = now();
    client.on("error", () => client.destroy());

    let buf = Buffer.alloc(0);
    let phase: "preamble" | "sni" = protocol === "postgres" ? "preamble" : "sni";
    let sslRequest: Buffer | null = null;
    const preamble = new PgPreamble();

    let routing = false; // SNI resolved — stop parsing, keep buffering until the flush
    let settled = false; // handshake done (spliced or aborted) — idempotency guard
    const hsTimer = setTimeout(() => abort(), handshakeMs);

    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (routing) return; // just accumulate; route() will flush what's buffered
      try {
        pump();
      } catch {
        abort();
      }
    };
    client.on("data", onData);

    function abort(): void {
      if (settled) return;
      settled = true;
      clearTimeout(hsTimer);
      client.removeListener("data", onData);
      if (!client.destroyed) client.destroy();
    }

    function pump(): void {
      if (phase === "preamble") {
        const d = preamble.decide(buf);
        if (d.kind === "incomplete") return;
        if (d.kind === "reject") return abort();
        if (d.kind === "gss-retry") {
          client.write(d.reply); // 'N' — libpq will follow with an SSLRequest
          buf = Buffer.from(d.rest);
          return; // stay in preamble; decide() rejects a second GSS
        }
        // valid SSLRequest — answer 'S' ourselves so the client sends its ClientHello.
        sslRequest = d.sslRequest;
        client.write(d.reply); // REPLY_WILLING
        buf = Buffer.from(d.rest); // usually empty (client waits for 'S' before the ClientHello)
        phase = "sni";
        // fall through: any leftover bytes may already start the ClientHello.
      }

      // phase === "sni"
      if (buf.length > MAX_CLIENT_HELLO) return abort();
      const r = extractSni(buf);
      if (r.status === "incomplete") return;
      if (r.status === "error") return abort();

      // Parsed a complete ClientHello (r.sni may be null). Stop parsing; keep buffering (the
      // client's next TLS flight may arrive while we dial) — route() flushes the lot upstream.
      routing = true;
      clearTimeout(hsTimer);
      void route(r.sni);
    }

    async function route(sni: string | null): Promise<void> {
      if (!sni) return void abort(); // no SNI ⇒ no routing key on a shared port
      const target = await opts.source.resolveSni(sni);
      if (!target) return void abort(); // unknown / not exposed — NO upstream dial

      if (!tryAcquire(target.workload)) return void abort(); // over the per-workload cap
      const release = releaser(target.workload);
      try {
        const upstream = await dial(target.host, target.port);
        if (sslRequest) {
          // Postgres: replay the ORIGINAL SSLRequest and swallow the upstream's own 'S'.
          upstream.write(sslRequest);
          const reply = await readUpstreamSslReply(upstream);
          if (reply !== REPLY_WILLING.toString()) {
            release();
            upstream.destroy();
            return void abort();
          }
        }
        // Hand off to the splice: swap the buffering listener for the pipe in one tick, flush
        // everything peeked (ClientHello + any bytes that arrived while dialing) verbatim.
        settled = true;
        client.removeListener("data", onData);
        const pending = buf;
        if (pending.length) upstream.write(pending);
        splice(client, upstream, target.workload, pending.length, start, release);
      } catch {
        release();
        abort();
      }
    }
  }

  /** Dynamic-port path: resolve by the port the client actually connected to (no peeking),
   *  then splice. Using `localPort` (not the configured port) keeps ephemeral test ports honest.
   *  Data is buffered from the first byte for protocols that speak first (a client that writes
   *  before we've dialed the upstream must not lose those bytes). */
  function handleDynamic(client: Socket): void {
    const start = now();
    client.on("error", () => client.destroy());
    const port = client.localPort ?? 0;

    let buf = Buffer.alloc(0);
    let piping = false;
    const onData = (d: Buffer) => {
      if (piping) return;
      buf = Buffer.concat([buf, d]);
    };
    client.on("data", onData);

    void (async () => {
      const target = await opts.source.resolvePort(port);
      if (!target) return void client.destroy(); // unallocated port
      if (!tryAcquire(target.workload)) return void client.destroy();
      const release = releaser(target.workload);
      try {
        const upstream = await dial(target.host, target.port);
        piping = true;
        client.removeListener("data", onData);
        const pending = buf;
        if (pending.length) upstream.write(pending);
        splice(client, upstream, target.workload, pending.length, start, release);
      } catch {
        release();
        if (!client.destroyed) client.destroy();
      }
    })();
  }

  // --- listeners: one net.Server per port ------------------------------------------------
  const listeners: { server: Server; configuredPort: number; kind: SharedProtocol | "dynamic" }[] = [];

  for (const sp of opts.sharedPorts) {
    const server = createServer((c) => handleShared(c, sp.protocol));
    server.on("error", () => {}); // a listen/accept error must never crash the router
    listeners.push({ server, configuredPort: sp.port, kind: sp.protocol });
  }
  for (const port of opts.dynamicPorts ?? []) {
    const server = createServer((c) => handleDynamic(c));
    server.on("error", () => {});
    listeners.push({ server, configuredPort: port, kind: "dynamic" });
  }

  function addresses(): ListenerInfo[] {
    return listeners.map((l) => {
      const addr = l.server.address() as AddressInfo | null;
      return { configuredPort: l.configuredPort, port: addr ? addr.port : l.configuredPort, kind: l.kind };
    });
  }

  return {
    listen(): Promise<ListenerInfo[]> {
      return Promise.all(
        listeners.map(
          (l) =>
            new Promise<void>((resolve, reject) => {
              l.server.once("error", reject);
              l.server.listen(l.configuredPort, "0.0.0.0", () => {
                l.server.removeListener("error", reject);
                resolve();
              });
            }),
        ),
      ).then(() => addresses());
    },
    close(): Promise<void> {
      return Promise.all(listeners.map((l) => new Promise<void>((resolve) => l.server.close(() => resolve())))).then(() => undefined);
    },
    addresses,
  };
}
