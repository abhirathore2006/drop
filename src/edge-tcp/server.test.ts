import { test, expect } from "bun:test";
import * as net from "node:net";
import * as tls from "node:tls";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createEdgeTcpServer, type EdgeTcpServerOptions, type TcpConnStats } from "./server.ts";
import { StaticRouteSource } from "./route-source.ts";
import { SSL_REQUEST_CODE, PREAMBLE_LEN } from "./pg-preamble.ts";

// Test-only self-signed cert (CN=test.drop.example.com). Generated at authoring time via
// `openssl req -x509`; NOT a real credential — it exists solely to let the in-proc upstreams
// complete a real TLS handshake so we can prove bytes flow end-to-end encrypted through the
// router's splice.
const CERT = readFileSync(new URL("./testdata/echo-cert.pem", import.meta.url));
const KEY = readFileSync(new URL("./testdata/echo-key.pem", import.meta.url));

// ---- in-proc upstreams -----------------------------------------------------------------

// bun can't run a server-side TLSSocket over an existing net.Socket, so the TLS is terminated
// by a normal `tls.createServer` (the "inner" echo) that only ever sees TLS bytes. An "outer"
// raw server terminates any cleartext preamble, then pipes the remaining bytes to the inner
// server — buffering from the first byte so nothing sent before the pipe is wired is lost.
function pipeToInner(raw: net.Socket, innerPort: number, leftover: Buffer): void {
  let pending = leftover;
  let inner: net.Socket | null = null;
  raw.on("data", (x: Buffer) => {
    if (inner) inner.write(x);
    else pending = Buffer.concat([pending, x]);
  });
  const conn = net.connect(innerPort, "127.0.0.1");
  conn.on("error", () => raw.destroy());
  raw.on("error", () => conn.destroy());
  conn.on("connect", () => {
    if (pending.length) conn.write(pending);
    inner = conn;
    conn.on("data", (x: Buffer) => raw.write(x));
    raw.on("close", () => conn.destroy());
    conn.on("close", () => raw.destroy());
  });
}

/** Boot a `tls.createServer` echo (decrypts, echoes plaintext) and return its port + closer. */
async function innerTlsEcho(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = tls.createServer({ cert: CERT, key: KEY }, (t) => t.on("data", (d: Buffer) => t.write(d)));
  server.on("tlsClientError", () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A TLS echo upstream (tls-sni path): the outer raw server pipes straight to the inner TLS
 *  echo. Counts raw TCP connections so a test can assert the router never dialed. */
async function tlsEchoUpstream(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  const echo = await innerTlsEcho();
  let conns = 0;
  const outer = net.createServer((raw) => {
    conns++;
    raw.on("error", () => raw.destroy());
    pipeToInner(raw, echo.port, Buffer.alloc(0));
  });
  await new Promise<void>((r) => outer.listen(0, "127.0.0.1", r));
  return {
    port: (outer.address() as net.AddressInfo).port,
    connections: () => conns,
    close: () => Promise.all([new Promise<void>((r) => outer.close(() => r())), echo.close()]).then(() => undefined),
  };
}

/** A Postgres-style TLS upstream: the outer raw server reads the replayed 8-byte SSLRequest,
 *  answers 'S', then pipes the following TLS bytes to the inner echo. Records the SSLRequest. */
async function pgTlsEchoUpstream(): Promise<{ port: number; sawSslRequest: () => boolean; close: () => Promise<void> }> {
  const echo = await innerTlsEcho();
  let sawSsl = false;
  const outer = net.createServer((raw) => {
    raw.on("error", () => raw.destroy());
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < PREAMBLE_LEN) return;
      raw.removeListener("data", onData);
      const len = buf.readUInt32BE(0);
      const code = buf.readUInt32BE(4);
      const leftover = buf.subarray(PREAMBLE_LEN);
      if (len === PREAMBLE_LEN && code === SSL_REQUEST_CODE) {
        sawSsl = true;
        raw.write(Buffer.from("S"));
        pipeToInner(raw, echo.port, Buffer.from(leftover));
      } else {
        raw.destroy();
      }
    };
    raw.on("data", onData);
  });
  await new Promise<void>((r) => outer.listen(0, "127.0.0.1", r));
  return {
    port: (outer.address() as net.AddressInfo).port,
    sawSslRequest: () => sawSsl,
    close: () => Promise.all([new Promise<void>((r) => outer.close(() => r())), echo.close()]).then(() => undefined),
  };
}

/** A plain (non-TLS) TCP echo server — the target for the dynamic-port path. */
async function plainEchoUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    sock.on("error", () => sock.destroy());
    sock.on("data", (d: Buffer) => sock.write(d));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---- router harness --------------------------------------------------------------------

/** Start a router with one listener of each kind on ephemeral ports (never 5432). */
async function startRouter(source: StaticRouteSource, extra: Partial<EdgeTcpServerOptions> = {}) {
  const server = createEdgeTcpServer({
    source,
    sharedPorts: [
      { port: 0, protocol: "tls-sni" },
      { port: 0, protocol: "postgres" },
    ],
    dynamicPorts: [0],
    ...extra,
  });
  const infos = await server.listen();
  const portOf = (kind: "tls-sni" | "postgres" | "dynamic") => infos.find((i) => i.kind === kind)!.port;
  return { server, portOf, close: () => server.close() };
}

// ---- client helpers --------------------------------------------------------------------

function sslRequestBytes(): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(PREAMBLE_LEN, 0);
  b.writeUInt32BE(SSL_REQUEST_CODE, 4);
  return b;
}

/** Open a TLS connection THROUGH the router (tls-sni path). Rejects if the router closes the
 *  socket before the handshake completes (the unknown-SNI / cap-exceeded cases). */
function tlsConnect(port: number, servername: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false });
    let done = false;
    sock.once("secureConnect", () => {
      done = true;
      resolve(sock);
    });
    sock.once("error", (e) => {
      if (!done) reject(e);
    });
    sock.once("close", () => {
      if (!done) reject(new Error("router closed before secureConnect"));
    });
  });
}

/** Drive the libpq preamble by hand, then upgrade to TLS through the router (postgres path). */
async function pgConnect(port: number, servername: string): Promise<tls.TLSSocket> {
  const raw = net.connect(port, "127.0.0.1");
  await once(raw, "connect");
  raw.write(sslRequestBytes());
  const first = await new Promise<string>((resolve, reject) => {
    const onData = (d: Buffer) => {
      if (d.length === 0) return;
      raw.removeListener("data", onData);
      if (d.length > 1) raw.unshift(d.subarray(1));
      resolve(String.fromCharCode(d[0]!));
    };
    raw.on("data", onData);
    raw.once("error", reject);
    raw.once("close", () => reject(new Error("closed before SSL reply")));
  });
  if (first !== "S") throw new Error(`expected 'S', got '${first}'`);
  return await new Promise((resolve, reject) => {
    const t = tls.connect({ socket: raw, servername, rejectUnauthorized: false });
    t.once("secureConnect", () => resolve(t));
    t.once("error", reject);
  });
}

/** Write one message and resolve with the first echoed chunk. */
function echoOnce(sock: tls.TLSSocket | net.Socket, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (d: Buffer) => {
      sock.removeListener("data", onData);
      resolve(d.toString());
    };
    sock.on("data", onData);
    sock.once("error", reject);
    sock.write(message);
  });
}

/** Plain-TCP round trip (dynamic-port path). */
function plainEcho(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.on("connect", () => sock.write(message));
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= Buffer.byteLength(message)) {
        resolve(buf.toString());
        sock.destroy();
      }
    });
    sock.on("error", reject);
  });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- tests -----------------------------------------------------------------------------

test("(a) TLS-SNI path: bytes echo end-to-end encrypted through the router", async () => {
  const upstream = await tlsEchoUpstream();
  const source = new StaticRouteSource();
  const stats: TcpConnStats[] = [];
  const { portOf, close } = await startRouter(source, { onClose: (s) => stats.push(s) });
  source.setSni("app.drop.example.com", { host: "127.0.0.1", port: upstream.port, workload: "app" });

  const sock = await tlsConnect(portOf("tls-sni"), "app.drop.example.com");
  expect(await echoOnce(sock, "hello tls")).toBe("hello tls");
  expect(await echoOnce(sock, "second frame")).toBe("second frame");
  sock.destroy();
  await wait(50);

  // The byte counter (G2 seam) fired once, attributed to the workload, with the ClientHello +
  // both messages counted inbound.
  expect(stats.length).toBe(1);
  expect(stats[0]!.workload).toBe("app");
  expect(stats[0]!.bytesIn).toBeGreaterThan(0);
  expect(stats[0]!.bytesOut).toBeGreaterThan(0);

  await close();
  await upstream.close();
});

test("(b) Postgres preamble path: SSLRequest replayed upstream, 'S' relayed, TLS echoes", async () => {
  const upstream = await pgTlsEchoUpstream();
  const source = new StaticRouteSource().setSni("pg.drop.example.com", { host: "127.0.0.1", port: upstream.port, workload: "pg" });
  const { portOf, close } = await startRouter(source);

  const sock = await pgConnect(portOf("postgres"), "pg.drop.example.com");
  expect(await echoOnce(sock, "select 1")).toBe("select 1");
  expect(upstream.sawSslRequest()).toBe(true);
  sock.destroy();

  await close();
  await upstream.close();
});

test("(c) unknown SNI → connection closed, no upstream dial", async () => {
  const upstream = await tlsEchoUpstream();
  const source = new StaticRouteSource(); // empty — nothing resolves
  const { portOf, close } = await startRouter(source);

  let failed = false;
  try {
    const s = await tlsConnect(portOf("tls-sni"), "nope.drop.example.com");
    s.destroy();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(upstream.connections()).toBe(0); // the router never dialed

  await close();
  await upstream.close();
});

test("(d) per-workload cap: a second concurrent connection over the cap is refused", async () => {
  const upstream = await tlsEchoUpstream();
  const source = new StaticRouteSource().setSni("cap.drop.example.com", { host: "127.0.0.1", port: upstream.port, workload: "cap" });
  const { portOf, close } = await startRouter(source, { maxConnsPerWorkload: 1 });

  const s1 = await tlsConnect(portOf("tls-sni"), "cap.drop.example.com");
  expect(await echoOnce(s1, "one")).toBe("one"); // slot 1 held

  let refused = false;
  try {
    const s2 = await tlsConnect(portOf("tls-sni"), "cap.drop.example.com");
    s2.destroy();
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);

  // Freeing the first slot lets a new connection through again.
  s1.destroy();
  await wait(80);
  const s3 = await tlsConnect(portOf("tls-sni"), "cap.drop.example.com");
  expect(await echoOnce(s3, "three")).toBe("three");
  s3.destroy();

  await close();
  await upstream.close();
});

test("(e) dynamic port: routes by port number without peeking (plain TCP)", async () => {
  const upstream = await plainEchoUpstream();
  const source = new StaticRouteSource();
  const { portOf, close } = await startRouter(source);
  const dynPort = portOf("dynamic");
  source.setPort(dynPort, { host: "127.0.0.1", port: upstream.port, workload: "redis" });

  // Non-TLS bytes route fine — the dynamic path never parses the payload.
  expect(await plainEcho(dynPort, "PING\r\n")).toBe("PING\r\n");

  await close();
  await upstream.close();
});

test("(e') dynamic port: an unallocated port closes the connection", async () => {
  const source = new StaticRouteSource(); // no port routes
  const { portOf, close } = await startRouter(source);
  const dynPort = portOf("dynamic");

  const closed = await new Promise<boolean>((resolve) => {
    const sock = net.connect(dynPort, "127.0.0.1");
    sock.on("connect", () => sock.write("hello"));
    sock.on("close", () => resolve(true));
    sock.on("error", () => resolve(true));
    setTimeout(() => resolve(false), 1000);
  });
  expect(closed).toBe(true);

  await close();
});
