import { test, expect } from "bun:test";
import * as net from "node:net";
import { once } from "node:events";
import * as crypto from "node:crypto";
import { createWsUpgradeHandler, type WsProxyOptions } from "./ws-proxy.ts";
import { FakeBlob } from "../blob/fake.ts";
import { MetaStore } from "../metastore/store.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { makeTestDb } from "../db/testdb.ts";

// ---- fixtures (mirror src/edge/server.test.ts conventions) ----------------------------

async function base() {
  const db = await makeTestDb();
  await new UserStore(db).upsertOnLogin("alice@example.com", null);
  return { db, meta: new MetaStore(db), blob: new FakeBlob(), orgs: new OrgStore(db) };
}

async function claim(meta: MetaStore, orgs: OrgStore, name: string, owner: string, type: "site" | "app" | "database" = "site") {
  const o = await orgs.ensurePersonalOrg(owner);
  return meta.claimSite(name, owner, type, { id: o.id, namespace: o.namespace });
}

/** A deployed app named `chat` the WS path can gate + route. */
async function appMeta(): Promise<MetaStore> {
  const { meta, orgs } = await base();
  await claim(meta, orgs, "chat", "alice@example.com", "app");
  await meta.updateSite("chat", (s) => ({ ...s, currentVersion: "v1" }));
  return meta;
}

/** Start an "edge" that dispatches WebSocket upgrades to our handler exactly as Node's
 *  http.Server does internally: parse the request head, then call the handler with a
 *  minimal IncomingMessage + the raw socket + the post-headers `head` bytes.
 *
 *  Why not `http.createServer` + `server.on('upgrade')`? Bun's node:http upgrade socket
 *  silently drops raw writes (bytes never reach the client), so it can't drive this test.
 *  Production runs on Node (`node dist/edge.js`), where the real `server.on('upgrade')`
 *  wiring in bin/edge.ts works; this net-based dispatcher exercises the handler's own
 *  logic (gate, cap, splice, upstream connect) over a plain socket that does flush. */
async function startEdge(opts: WsProxyOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = createWsUpgradeHandler(opts);
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let buf = Buffer.alloc(0);
    let handled = false;
    const onData = (d: Buffer) => {
      if (handled) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      handled = true;
      socket.removeListener("data", onData);
      const headText = buf.subarray(0, i).toString("latin1");
      const head = buf.subarray(i + 4);
      const lines = headText.split("\r\n");
      const [method, url] = lines[0]!.split(" ");
      const headers: Record<string, string> = {};
      const rawHeaders: string[] = [];
      for (const line of lines.slice(1)) {
        const c = line.indexOf(":");
        if (c === -1) continue;
        const k = line.slice(0, c).trim();
        const v = line.slice(c + 1).trim();
        rawHeaders.push(k, v);
        const lk = k.toLowerCase();
        headers[lk] = lk in headers ? `${headers[lk]}, ${v}` : v;
      }
      const req = { method, url, headers, rawHeaders, socket } as unknown as Parameters<typeof handler>[0];
      handler(req, socket, head);
    };
    socket.on("data", onData);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---- hand-rolled minimal WebSocket helpers (no `ws` dep) -------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Encode a client→server text frame (FIN+text, masked as the spec requires; len < 126). */
function encodeMaskedText(payload: string): Buffer {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i]! ^ mask[i % 4]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, masked]);
}

/** Encode a server→client text frame (unmasked; len < 126). */
function encodeUnmaskedText(payload: string): Buffer {
  const data = Buffer.from(payload);
  return Buffer.concat([Buffer.from([0x81, data.length]), data]);
}

/** Decode a single text frame from `buf`, returning the payload + the remaining bytes, or
 *  null if a full frame isn't buffered yet. Handles masked + unmasked, len < 126. */
function decodeText(buf: Buffer): { text: string; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const len = buf[1]! & 0x7f;
  const masked = (buf[1]! & 0x80) !== 0;
  let off = 2;
  let mask: Buffer | null = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  let data = buf.subarray(off, off + len);
  if (mask) {
    const u = Buffer.alloc(len);
    for (let i = 0; i < len; i++) u[i] = data[i]! ^ mask[i % 4]!;
    data = u;
  }
  return { text: data.toString(), rest: buf.subarray(off + len) };
}

/** A raw net server that completes the WS handshake and echoes text frames — stands in for
 *  the KEDA interceptor + app (from the edge's view it's just a TCP upstream that speaks WS). */
async function wsEchoUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    let buf: Buffer = Buffer.alloc(0);
    let handshaked = false;
    sock.on("error", () => sock.destroy());
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaked) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        const headText = buf.subarray(0, i).toString();
        const key = /sec-websocket-key:\s*(.+)/i.exec(headText)?.[1]?.trim() ?? "";
        const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
        sock.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        handshaked = true;
        buf = buf.subarray(i + 4);
      }
      let frame = decodeText(buf);
      while (frame) {
        sock.write(encodeUnmaskedText(frame.text));
        buf = frame.rest;
        frame = decodeText(buf);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function handshakeReq(host: string, extra: Record<string, string> = {}): string {
  const key = crypto.randomBytes(16).toString("base64");
  let h = `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
  for (const [k, v] of Object.entries(extra)) h += `${k}: ${v}\r\n`;
  return h + "\r\n";
}

/** Send an upgrade and read back the first HTTP status line (for rejected upgrades). */
async function upgradeStatus(port: number, host: string, extra: Record<string, string> = {}): Promise<{ status: string; got101: boolean }> {
  const sock = net.connect(port, "127.0.0.1");
  await once(sock, "connect");
  sock.write(handshakeReq(host, extra));
  let buf = Buffer.alloc(0);
  const status = await new Promise<string>((resolve) => {
    const line = () => {
      const i = buf.indexOf("\r\n");
      return i === -1 ? "" : buf.subarray(0, i).toString();
    };
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.indexOf("\r\n") !== -1) resolve(line());
    });
    sock.on("error", () => resolve(line() || "ERROR"));
    sock.on("close", () => resolve(line() || "CLOSED"));
  });
  sock.destroy();
  return { status, got101: / 101 /.test(status) };
}

/** Complete a handshake through the edge and return the open socket (asserts 101). */
async function connectWs(port: number, host: string): Promise<net.Socket> {
  const sock = net.connect(port, "127.0.0.1");
  await once(sock, "connect");
  sock.write(handshakeReq(host));
  let buf = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      const status = buf.subarray(0, buf.indexOf("\r\n")).toString();
      sock.removeListener("data", onData);
      sock.removeListener("error", reject);
      if (/ 101 /.test(status)) resolve();
      else reject(new Error(status));
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
  return sock;
}

/** Send one masked text frame and resolve with the echoed payload. */
function echoOnce(sock: net.Socket, message: string): Promise<string> {
  let buf = Buffer.alloc(0);
  const p = new Promise<string>((resolve, reject) => {
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const f = decodeText(buf);
      if (f) {
        sock.removeListener("data", onData);
        resolve(f.text);
      }
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
  sock.write(encodeMaskedText(message));
  return p;
}

// ---- tests -----------------------------------------------------------------------------

test("pre-upgrade gate: viewer-blocked (private) host gets 403 and no 101", async () => {
  const { meta, orgs } = await base();
  await claim(meta, orgs, "secretapp", "alice@example.com", "app");
  await meta.updateSite("secretapp", (s) => ({ ...s, currentVersion: "v1" }));
  await meta.setVisibility("secretapp", "private", null);
  // Point at a bogus interceptor: the gate must reject BEFORE any upstream connect.
  const edge = await startEdge({ meta, baseDomain: "drop.example.com", interceptorUrl: "http://127.0.0.1:1" });

  const r = await upgradeStatus(edge.port, "secretapp.drop.example.com");
  expect(r.got101).toBe(false);
  expect(r.status).toContain("403");
  await edge.close();
});

test("pre-upgrade gate: password host with no credentials gets 401 and no 101", async () => {
  const { meta, orgs } = await base();
  await claim(meta, orgs, "pwapp", "alice@example.com", "app");
  await meta.updateSite("pwapp", (s) => ({ ...s, currentVersion: "v1" }));
  const { hashPassword } = await import("../site-config.ts");
  await meta.setVisibility("pwapp", "password", hashPassword("opensesame"));
  const edge = await startEdge({ meta, baseDomain: "drop.example.com", interceptorUrl: "http://127.0.0.1:1" });

  const r = await upgradeStatus(edge.port, "pwapp.drop.example.com");
  expect(r.got101).toBe(false);
  expect(r.status).toContain("401");
  await edge.close();
});

test("unknown host → 404, no upstream connect", async () => {
  const meta = await appMeta();
  const edge = await startEdge({ meta, baseDomain: "drop.example.com", interceptorUrl: "http://127.0.0.1:1" });
  const r = await upgradeStatus(edge.port, "nope.drop.example.com");
  expect(r.got101).toBe(false);
  expect(r.status).toContain("404");
  await edge.close();
});

test("non-app host (static site) → 404 for a WS upgrade", async () => {
  const { meta, orgs } = await base();
  await claim(meta, orgs, "plainsite", "alice@example.com", "site");
  await meta.updateSite("plainsite", (s) => ({ ...s, currentVersion: "v1" }));
  const edge = await startEdge({ meta, baseDomain: "drop.example.com", interceptorUrl: "http://127.0.0.1:1" });
  const r = await upgradeStatus(edge.port, "plainsite.drop.example.com");
  expect(r.got101).toBe(false);
  expect(r.status).toContain("404");
  await edge.close();
});

test("end-to-end: a client WS echoes through the edge to the upstream", async () => {
  const meta = await appMeta();
  const upstream = await wsEchoUpstream();
  const edge = await startEdge({ meta, baseDomain: "drop.example.com", interceptorUrl: upstream.url });

  const sock = await connectWs(edge.port, "chat.drop.example.com");
  expect(await echoOnce(sock, "hello ws")).toBe("hello ws");
  expect(await echoOnce(sock, "second frame")).toBe("second frame");
  sock.destroy();
  await edge.close();
  await upstream.close();
});

test("per-host cap: a second concurrent upgrade over the limit gets 503", async () => {
  const meta = await appMeta();
  const upstream = await wsEchoUpstream();
  const edge = await startEdge({ meta, baseDomain: "drop.example.com", interceptorUrl: upstream.url, maxPerHost: 1 });

  // First connection establishes (101) → the per-host count is now 1.
  const s1 = await connectWs(edge.port, "chat.drop.example.com");
  // Second upgrade for the same host is over the cap → 503, no 101.
  const r = await upgradeStatus(edge.port, "chat.drop.example.com");
  expect(r.got101).toBe(false);
  expect(r.status).toContain("503");

  // Closing the first frees the slot → a new upgrade succeeds again.
  s1.destroy();
  await once(s1, "close");
  const s2 = await connectWs(edge.port, "chat.drop.example.com");
  expect(await echoOnce(s2, "back in")).toBe("back in");
  s2.destroy();

  await edge.close();
  await upstream.close();
});

test("non-websocket upgrade (e.g. h2c) is refused with 501", async () => {
  const meta = await appMeta();
  const edge = await startEdge({ meta, baseDomain: "drop.example.com", interceptorUrl: "http://127.0.0.1:1" });
  const sock = net.connect(edge.port, "127.0.0.1");
  await once(sock, "connect");
  sock.write("GET / HTTP/1.1\r\nHost: chat.drop.example.com\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n");
  let buf = Buffer.alloc(0);
  const status = await new Promise<string>((resolve) => {
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n");
      if (i !== -1) resolve(buf.subarray(0, i).toString());
    });
    sock.on("close", () => resolve(buf.toString()));
  });
  expect(status).toContain("501");
  sock.destroy();
  await edge.close();
});
