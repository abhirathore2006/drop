import { test, expect } from "bun:test";
import * as net from "node:net";
import { once } from "node:events";
import { createApp } from "../api/server.ts";
import { createDbTunnelHandler, type DbTunnelStats } from "../api/db-tunnel.ts";
import { TunnelTicketStore } from "../tokens/tunnel-tickets.ts";
import { newSecWebSocketKey } from "../ws/frames.ts";
import { runDbProxy } from "./db-proxy.ts";
import { FakeBlob } from "../blob/fake.ts";
import { FakeKube } from "../kube/fake.ts";
import { FakeSecretStore } from "../secrets/fake.ts";
import { FakeImageStore } from "../images/fake.ts";
import { FakeBucketStore } from "../buckets/fake.ts";
import { QuotaStore } from "../quotas/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { LockStore } from "../metastore/lock.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { AuditStore } from "../audit/store.ts";
import { ServiceTokenStore } from "../tokens/store.ts";
import { makeTestDb } from "../db/testdb.ts";
import { FakeVerifier, ChainVerifier } from "../auth/oidc.ts";
import { TokenVerifier } from "../auth/token-verifier.ts";
import { loadConfig } from "../config.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A trivial TCP "database": echoes every byte back (stands in for `<db>-rw.<ns>.svc:5432`). */
async function echoDb(): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    sock.on("error", () => sock.destroy());
    sock.on("data", (d) => sock.write(d));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { host: "127.0.0.1", port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A minimal API "server" over a raw TCP socket: WebSocket upgrades go to the db:proxy tunnel handler
 *  (Bun's node:http upgrade socket silently drops raw writes — same reason src/edge/ws-proxy.test.ts
 *  dispatches over plain sockets — while production runs on Node where the real `server.on('upgrade')`
 *  works); every other request bridges to the Hono app via `app.fetch`. */
function startApi(app: any, tunnelHandler: (req: any, socket: net.Socket, head: Buffer) => void) {
  const server = net.createServer((sock) => {
    sock.on("error", () => sock.destroy());
    let buf = Buffer.alloc(0);
    let handled = false;
    const onHead = (d: Buffer) => {
      if (handled) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      handled = true;
      sock.removeListener("data", onHead);
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
        headers[k.toLowerCase()] = v;
      }
      if ((headers.upgrade ?? "").toLowerCase() === "websocket") {
        tunnelHandler({ method, url, headers, rawHeaders, socket: sock }, sock, head);
        return;
      }
      // Ordinary HTTP → bridge to the Hono app (bodies are empty for the ticket POST; content-length 0).
      void (async () => {
        const reqHeaders: Record<string, string> = {};
        if (headers.authorization) reqHeaders.authorization = headers.authorization;
        if (headers["content-type"]) reqHeaders["content-type"] = headers["content-type"];
        const res = await app.fetch(new Request(`http://127.0.0.1${url}`, { method, headers: reqHeaders }));
        const body = Buffer.from(await res.arrayBuffer());
        let out = `HTTP/1.1 ${res.status} ${res.status === 200 ? "OK" : "X"}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`;
        sock.write(out);
        sock.write(body);
        sock.end();
      })();
    };
    sock.on("data", onHead);
  });
  return new Promise<{ baseUrl: string; port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

interface BootOpts {
  maxTunnelsPerUser?: number;
  idleTimeoutMs?: number;
  target?: { host: string; port: number } | null; // null → force the 501 (no in-cluster route) path
  onClose?: (s: DbTunnelStats) => void;
}

/** Boot the API app + a shared ticket store + the tunnel handler, create alice's `mydb`, and start
 *  the raw dispatcher. Returns everything a test needs. `db` is the echo "database". */
async function boot(opts: BootOpts = {}) {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  const audit = new AuditStore(db);
  const tokens = new ServiceTokenStore(db);
  const tickets = new TunnelTicketStore(db);
  const cfg = loadConfig({
    DROP_S3_BUCKET: "b",
    DROP_DATABASE_URL: "postgres://x/y",
    DROP_BASE_DOMAIN: "drop.example.com",
    DROP_S3_ENDPOINT: "http://localhost:4566", // "local" DB path (static creds, no IRSA)
  });
  const fake = new FakeVerifier({ alice: { sub: "alice@example.com", email: "alice@example.com" } });
  const verifier = new ChainVerifier([new TokenVerifier(tokens, orgs), fake]);
  const app = createApp({
    cfg,
    meta,
    blob: new FakeBlob(),
    db,
    users,
    verifier,
    kube: new FakeKube(),
    secrets: new FakeSecretStore(),
    images: new FakeImageStore(),
    orgs,
    audit,
    locks: new LockStore(db),
    bucket: new FakeBucketStore(),
    quotas: new QuotaStore(db),
    tokens,
    tickets,
  });

  // alice creates mydb (claims + applies FakeKube; her personal org).
  const created = await app.request("/v1/databases/mydb", {
    method: "POST",
    headers: { authorization: "Bearer alice", "content-type": "application/json" },
    body: "{}",
  });
  expect(created.status).toBe(200);

  const echo = await echoDb();
  const auditEvents: any[] = [];
  const handler = createDbTunnelHandler({
    meta,
    tickets,
    resolveTarget: () => (opts.target === undefined ? { host: echo.host, port: echo.port } : opts.target),
    audit: (e) => auditEvents.push(e),
    maxTunnelsPerUser: opts.maxTunnelsPerUser,
    idleTimeoutMs: opts.idleTimeoutMs,
    onClose: opts.onClose,
  });
  const api = await startApi(app, handler);
  return {
    api,
    echo,
    tickets,
    auditEvents,
    session: { apiBase: api.baseUrl, token: "alice" },
    async cleanup() {
      await api.close();
      await echo.close();
      await db.destroy();
    },
  };
}

/** A raw upgrade handshake (for rejection / cap / reuse assertions). Returns the status line + socket. */
function rawUpgrade(baseUrl: string, path: string): Promise<{ status: string; socket: net.Socket }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Key: ${newSecWebSocketKey()}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.indexOf("\r\n") === -1) return;
      const status = buf.subarray(0, buf.indexOf("\r\n")).toString();
      sock.removeAllListeners("data");
      resolve({ status, socket: sock });
    });
    sock.on("error", reject);
  });
}

// ---- tests -------------------------------------------------------------------------------------

test("e2e: the CLI proxy tunnels psql bytes both ways through an authenticated WebSocket, and audits the open", async () => {
  const b = await boot();
  const proxy = await runDbProxy({ session: b.session, db: "mydb" });

  // A "psql client" connects to the local listener and round-trips two messages through the echo DB.
  const client = net.connect(proxy.port, "127.0.0.1");
  await once(client, "connect");

  const collect = (expectLen: number) =>
    new Promise<Buffer>((resolve) => {
      let acc = Buffer.alloc(0);
      const on = (d: Buffer) => {
        acc = Buffer.concat([acc, d]);
        if (acc.length >= expectLen) {
          client.removeListener("data", on);
          resolve(acc);
        }
      };
      client.on("data", on);
    });

  let want = collect(5);
  client.write(Buffer.from("hello"));
  expect((await want).toString()).toBe("hello");

  want = collect(6);
  client.write(Buffer.from("world!"));
  expect((await want).toString()).toBe("world!");

  // A larger payload exercises the 16-bit length path through the framing.
  const big = Buffer.alloc(5000, 0x7a);
  want = collect(big.length);
  client.write(big);
  expect((await want).equals(big)).toBe(true);

  client.destroy();
  await proxy.close();

  // The OPEN was audited at redemption (db.tunnel.open, actor alice, target mydb).
  const open = b.auditEvents.find((e) => e.action === "db.tunnel.open");
  expect(open).toBeTruthy();
  expect(open.actor).toBe("alice@example.com");
  expect(open.target).toBe("mydb");
  expect(open.targetType).toBe("database");

  await b.cleanup();
});

test("single-use: a ticket redeemed once is rejected (401) on reuse", async () => {
  const b = await boot();
  const { ticket } = await b.tickets.issue("mydb", "alice@example.com");
  const first = await rawUpgrade(b.api.baseUrl, `/v1/databases/mydb/tunnel?ticket=${ticket}`);
  expect(first.status).toContain("101"); // redeemed → tunnel open
  const second = await rawUpgrade(b.api.baseUrl, `/v1/databases/mydb/tunnel?ticket=${ticket}`);
  expect(second.status).toContain("401"); // spent → replay rejected
  first.socket.destroy();
  second.socket.destroy();
  await b.cleanup();
});

test("a ticket for one database cannot open another (wrong-db → 401)", async () => {
  const b = await boot();
  const { ticket } = await b.tickets.issue("mydb", "alice@example.com");
  // otherdb doesn't exist here; the wrong-db redeem fails before any lookup → 401.
  const r = await rawUpgrade(b.api.baseUrl, `/v1/databases/otherdb/tunnel?ticket=${ticket}`);
  expect(r.status).toContain("401");
  r.socket.destroy();
  await b.cleanup();
});

test("missing ticket → 401; a non-tunnel upgrade path → 404", async () => {
  const b = await boot();
  const noTicket = await rawUpgrade(b.api.baseUrl, `/v1/databases/mydb/tunnel`);
  expect(noTicket.status).toContain("401");
  const wrongPath = await rawUpgrade(b.api.baseUrl, `/v1/apps/whatever/socket`);
  expect(wrongPath.status).toContain("404");
  noTicket.socket.destroy();
  wrongPath.socket.destroy();
  await b.cleanup();
});

test("no in-cluster route (resolveTarget → null) returns 501 after redeeming", async () => {
  const b = await boot({ target: null });
  const { ticket } = await b.tickets.issue("mydb", "alice@example.com");
  const r = await rawUpgrade(b.api.baseUrl, `/v1/databases/mydb/tunnel?ticket=${ticket}`);
  expect(r.status).toContain("501");
  r.socket.destroy();
  await b.cleanup();
});

test("per-user concurrent cap: a tunnel over the limit is refused with 503", async () => {
  const b = await boot({ maxTunnelsPerUser: 1 });
  const t1 = await b.tickets.issue("mydb", "alice@example.com");
  const t2 = await b.tickets.issue("mydb", "alice@example.com");
  const first = await rawUpgrade(b.api.baseUrl, `/v1/databases/mydb/tunnel?ticket=${t1.ticket}`);
  expect(first.status).toContain("101"); // 1 active
  const second = await rawUpgrade(b.api.baseUrl, `/v1/databases/mydb/tunnel?ticket=${t2.ticket}`);
  expect(second.status).toContain("503"); // over the cap

  // Closing the first frees the slot → a fresh ticket connects again.
  first.socket.destroy();
  await sleep(50);
  const t3 = await b.tickets.issue("mydb", "alice@example.com");
  const third = await rawUpgrade(b.api.baseUrl, `/v1/databases/mydb/tunnel?ticket=${t3.ticket}`);
  expect(third.status).toContain("101");
  third.socket.destroy();
  await b.cleanup();
});

test("idle timeout: a tunnel with no traffic is torn down (onClose reason 'idle')", async () => {
  let closed: DbTunnelStats | undefined;
  const b = await boot({ idleTimeoutMs: 120, onClose: (s) => (closed = s) });
  const proxy = await runDbProxy({ session: b.session, db: "mydb" });
  const client = net.connect(proxy.port, "127.0.0.1");
  await once(client, "connect");
  // send nothing — the idle timer should fire and destroy both sockets
  await once(client, "close");
  // give the server's onClose a tick to run
  await sleep(30);
  expect(closed?.reason).toBe("idle");
  await proxy.close();
  await b.cleanup();
});
