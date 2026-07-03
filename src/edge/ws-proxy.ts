import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import type { MetaStore } from "../metastore/store.ts";
import { checkAccessGate, siteFromHost } from "./server.ts";

/** Options for the Node-level `upgrade` handler. Everything the HTTP path already has
 *  (meta, baseDomain, interceptorUrl) plus the WS-only limits + direct-route flag. */
export interface WsProxyOptions {
  meta: MetaStore;
  baseDomain: string;
  /** KEDA HTTP interceptor base URL — the SAME upstream the HTTP path proxies to. The
   *  upgrade is opened against this host with Host=<name>.<baseDomain> so KEDA routes it
   *  (and wakes the pod). Unset → no proxy path (only `direct` can serve). */
  interceptorUrl?: string;
  /** DROP_WS_DIRECT=1 — skip the interceptor and dial the app Service directly
   *  (<name>.<ns>.svc:<svcPort>) after a best-effort wake shim. Fallback for interceptor
   *  builds that reject WS upgrades. */
  direct?: boolean;
  /** App Service port for the direct path (default 80 — the ClusterIP Service port that
   *  `src/kube/manifests.ts` emits). */
  svcPort?: number;
  /** Per-host concurrent-upgrade cap (default 100, env DROP_WS_MAX_PER_HOST). */
  maxPerHost?: number;
  /** Idle timeout in ms — a connection with no bytes either way for this long has BOTH
   *  sockets destroyed (default 5 min, env DROP_WS_IDLE_TIMEOUT_MS). */
  idleTimeoutMs?: number;
  now?: () => number;
  /** Called once when a spliced connection closes, with the final byte counts — the seam
   *  a future metrics slice (A2) hooks into. Byte accounting lives in exactly one place
   *  (`splice`) so this stays a single, faithful counter. */
  onClose?: (stats: WsConnStats) => void;
}

export interface WsConnStats {
  /** The resolved site name (the per-host cap key). */
  host: string;
  bytesIn: number; // client → upstream
  bytesOut: number; // upstream → client
  reason: string; // client | upstream | idle | error
}

const REASON: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** Write a plain HTTP error to the raw upgrade socket and close it. The client never sees
 *  a 101, so a rejected WS never half-opens (the whole point of gating pre-upgrade). */
function writeHttpError(socket: Socket, status: number, body: string, headers: Record<string, string> = {}): void {
  if (socket.destroyed) return;
  const h: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    connection: "close",
    ...headers,
  };
  let msg = `HTTP/1.1 ${status} ${REASON[status] ?? "Error"}\r\n`;
  for (const [k, v] of Object.entries(h)) msg += `${k}: ${v}\r\n`;
  msg += `\r\n${body}`;
  socket.end(msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build a Node-level `server.on('upgrade')` handler. It runs the FULL visibility/session
 *  gate BEFORE any upstream connect, then splices the client socket to the app upstream
 *  (via the interceptor, or directly with a wake shim). Attach it in the edge entrypoint;
 *  upgrade requests never reach Hono. */
export function createWsUpgradeHandler(opts: WsProxyOptions): (req: IncomingMessage, socket: Socket, head: Buffer) => void {
  const now = opts.now ?? (() => Date.now());
  const maxPerHost = opts.maxPerHost ?? 100;
  const idleMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const svcPort = opts.svcPort ?? 80;
  const interceptor = opts.interceptorUrl ? new URL(opts.interceptorUrl) : null;
  // Live concurrent-upgrade counts, keyed by resolved site name.
  const perHost = new Map<string, number>();

  const upstreamHost = (name: string) => `${name}.${opts.baseDomain}`;

  /** A single TCP connect, resolving once the socket is open. */
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

  /** Poll a TCP endpoint until it accepts a connection or the budget runs out. The first
   *  successful connect IS the connection we splice — this is the readiness probe. */
  async function dialWithRetry(host: string, port: number, budgetMs: number): Promise<Socket> {
    const deadline = now() + budgetMs;
    let lastErr: unknown;
    for (;;) {
      try {
        return await dial(host, port);
      } catch (e) {
        lastErr = e;
        if (now() >= deadline) throw lastErr;
        await sleep(250);
      }
    }
  }

  /** Wake shim: fire one throwaway GET through the interceptor to scale a 0-replica app
   *  up. Fully best-effort — its response is discarded and any error is swallowed (a wake
   *  failure must never crash the edge or reject the pending upgrade before the poll). */
  function fireWake(name: string): void {
    if (!interceptor) return;
    const req = httpRequest({
      protocol: interceptor.protocol,
      hostname: interceptor.hostname,
      port: interceptor.port,
      method: "GET",
      path: "/",
      headers: { host: upstreamHost(name) },
      timeout: 10_000,
    });
    req.on("response", (res) => res.resume()); // drain + discard
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end();
  }

  /** Proxy path: connect to the interceptor (KEDA routes + wakes by the Host header). */
  function connectInterceptor(): Promise<Socket> {
    if (!interceptor) return Promise.reject(new Error("interceptor not configured"));
    return dial(interceptor.hostname, Number(interceptor.port) || 80);
  }

  /** Direct path: wake via the interceptor, then dial the app Service in-cluster. Needs
   *  the tenant namespace, so it reads the full site row (only in this opt-in mode). */
  async function connectDirect(name: string): Promise<Socket> {
    const site = await opts.meta.getSitePlain(name);
    if (!site) throw new Error("site vanished");
    fireWake(name);
    return dialWithRetry(`${name}.${site.namespace}.svc`, svcPort, 10_000);
  }

  /** Reconstruct the client's upgrade request for the upstream: preserve every header
   *  (casing + the Sec-WebSocket-* set) via rawHeaders, override Host to the registered
   *  app host (KEDA routes on it), and set the X-Forwarded-* trio the way the HTTP path's
   *  upstream would see it. */
  function buildUpgradeRequest(req: IncomingMessage, hostOverride: string): string {
    const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
    const raw = req.rawHeaders; // [k, v, k, v, ...] — original casing + duplicates
    for (let i = 0; i < raw.length; i += 2) {
      const lower = raw[i]!.toLowerCase();
      // Host + the X-Forwarded-* trio are re-emitted canonically below.
      if (lower === "host" || lower === "x-forwarded-host" || lower === "x-forwarded-proto" || lower === "x-forwarded-for") continue;
      lines.push(`${raw[i]}: ${raw[i + 1] ?? ""}`);
    }
    const origHost = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? hostOverride;
    const priorXff = req.headers["x-forwarded-for"];
    const ip = req.socket.remoteAddress;
    const xff = [priorXff, ip].filter(Boolean).join(", ");
    lines.push(`Host: ${hostOverride}`);
    lines.push(`X-Forwarded-Host: ${origHost}`);
    lines.push(`X-Forwarded-Proto: ${req.headers["x-forwarded-proto"] ?? "https"}`);
    if (xff) lines.push(`X-Forwarded-For: ${xff}`);
    return lines.join("\r\n") + "\r\n\r\n";
  }

  /** Bidirectional byte pump with backpressure, idle timeout, and byte counting — shared
   *  by both the interceptor and direct paths. All accounting is in this one function. */
  function splice(client: Socket, upstream: Socket, name: string, release: () => void): void {
    client.setNoDelay(true);
    let bytesIn = 0;
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
      opts.onClose?.({ host: name, bytesIn, bytesOut, reason });
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
  }

  return (req, socket, head) => {
    // A raw socket error before we splice must never become an uncaughtException (that
    // would crash the whole edge replica — a cross-tenant DoS, same class as proxyToApp).
    socket.on("error", () => socket.destroy());

    // Only WebSocket upgrades are tunnelled; anything else (h2c, etc.) is refused.
    if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      return writeHttpError(socket, 501, "unsupported upgrade");
    }

    const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "";
    const name = siteFromHost(host, opts.baseDomain);
    if (!name) return writeHttpError(socket, 404, "site not found");

    // Resolve + gate + connect, all off the request path. Any unhandled failure closes the
    // socket with a 502 — never a 101.
    void run(name).catch(() => {
      if (!socket.destroyed) writeHttpError(socket, 502, "bad gateway");
    });

    async function run(siteName: string): Promise<void> {
      const ptr = await opts.meta.getPointer(siteName);
      if (!ptr) return void writeHttpError(socket, 404, "site not found");

      // FULL visibility/password gate — the exact same helper the HTTP path uses, so a
      // viewer-blocked host is rejected identically (403 private / 401 password) before
      // any 101 is possible.
      const denial = checkAccessGate(
        { visibility: ptr.visibility, passwordHash: ptr.passwordHash, config: ptr.config ?? {} },
        req.headers.authorization,
      );
      if (denial) return void writeHttpError(socket, denial.status, denial.body, denial.headers);

      // A WebSocket only makes sense for a deployed app (a static site has no upstream).
      if (ptr.type !== "app") return void writeHttpError(socket, 404, "not a websocket endpoint");
      if (!ptr.currentVersion) return void writeHttpError(socket, 404, "app not deployed");

      // Per-host concurrent-upgrade cap so long-lived sockets can't pin edge memory.
      const active = perHost.get(siteName) ?? 0;
      if (active >= maxPerHost) return void writeHttpError(socket, 503, "too many websocket connections");
      perHost.set(siteName, active + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const n = (perHost.get(siteName) ?? 1) - 1;
        if (n <= 0) perHost.delete(siteName);
        else perHost.set(siteName, n);
      };

      try {
        const upstream = opts.direct ? await connectDirect(siteName) : await connectInterceptor();
        // Forward the client's handshake (the app computes Sec-WebSocket-Accept and emits
        // the 101 — the edge stays a transparent byte tunnel).
        upstream.write(buildUpgradeRequest(req, upstreamHost(siteName)));
        if (head && head.length) upstream.write(head);
        splice(socket, upstream, siteName, release);
      } catch {
        release();
        if (!socket.destroyed) writeHttpError(socket, 502, "upstream unavailable");
      }
    }
  };
}
