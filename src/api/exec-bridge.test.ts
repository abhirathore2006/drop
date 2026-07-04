import { test, expect } from "bun:test";
import * as net from "node:net";
import { createApp } from "./server.ts";
import { createExecHandler, type ExecStats } from "./exec-bridge.ts";
import { TunnelTicketStore } from "../tokens/tunnel-tickets.ts";
import { newSecWebSocketKey } from "../ws/frames.ts";
import { FakeKube } from "../kube/fake.ts";
import { FakeBlob } from "../blob/fake.ts";
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

interface BootOpts {
  maxExecPerUser?: number;
  idleTimeoutMs?: number;
  onClose?: (s: ExecStats) => void;
  noKube?: boolean; // build the exec handler with kube:undefined (compute-off posture)
  execNoPod?: boolean; // FakeKube returns null (no ready pod)
}

async function boot(opts: BootOpts = {}) {
  const db = await makeTestDb();
  const users = new UserStore(db);
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  const audit = new AuditStore(db);
  const tokens = new ServiceTokenStore(db);
  const tickets = new TunnelTicketStore(db);
  const kube = new FakeKube();
  kube.execNoPod = !!opts.execNoPod;
  const cfg = loadConfig({ DROP_S3_BUCKET: "b", DROP_DATABASE_URL: "postgres://x/y", DROP_BASE_DOMAIN: "drop.example.com", DROP_S3_ENDPOINT: "http://localhost:4566" });
  const fake = new FakeVerifier({
    alice: { sub: "alice@example.com", email: "alice@example.com" },
    bob: { sub: "bob@example.com", email: "bob@example.com" },
  });
  const verifier = new ChainVerifier([new TokenVerifier(tokens, orgs), fake]);
  const app = createApp({ cfg, meta, blob: new FakeBlob(), db, users, verifier, kube, secrets: new FakeSecretStore(), images: new FakeImageStore(), orgs, audit, locks: new LockStore(db), bucket: new FakeBucketStore(), quotas: new QuotaStore(db), tokens, tickets });

  await users.upsertOnLogin("alice@example.com", null);
  const org = await orgs.ensurePersonalOrg("alice@example.com");
  await meta.claimSite("myapp", "alice@example.com", "app", { id: org.id, namespace: org.namespace });
  await meta.claimSite("mydb", "alice@example.com", "database", { id: org.id, namespace: org.namespace });

  const auditEvents: any[] = [];
  const handler = createExecHandler({
    meta,
    tickets,
    kube: opts.noKube ? undefined : kube,
    audit: (e) => auditEvents.push(e),
    maxExecPerUser: opts.maxExecPerUser,
    idleTimeoutMs: opts.idleTimeoutMs,
    onClose: opts.onClose,
  });
  const ws = await startWs(handler);
  return {
    app,
    ws,
    kube,
    tickets,
    auditEvents,
    session: { apiBase: ws.baseUrl, token: "alice" },
    async cleanup() {
      await ws.close();
      await db.destroy();
    },
  };
}

/** A raw TCP server that routes EVERY upgrade to the exec handler (mirrors bin/api.ts's dispatch). */
function startWs(handler: (req: any, socket: net.Socket, head: Buffer) => void) {
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
      const lines = headText.split("\r\n");
      const [method, url] = lines[0]!.split(" ");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const c = line.indexOf(":");
        if (c === -1) continue;
        headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      handler({ method, url, headers, socket: sock }, sock, buf.subarray(i + 4));
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

/** A raw upgrade handshake; resolves the status line + socket. */
function rawUpgrade(baseUrl: string, path: string): Promise<{ status: string; socket: net.Socket }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${newSecWebSocketKey()}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
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

// ---- the exec-ticket ROUTE (Hono, no server) ---------------------------------------------------

async function post(app: any, path: string, token: string, body?: unknown) {
  return app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("exec-ticket route: mints an exec ticket for an app owner, echoing the bound command", async () => {
  const b = await boot();
  const res = await post(b.app, "/v1/apps/myapp/exec-ticket", "alice", { command: ["/bin/bash"] });
  expect(res.status).toBe(200);
  const j = (await res.json()) as any;
  expect(j.app).toBe("myapp");
  expect(j.ticket.startsWith("drop_tt_")).toBe(true);
  expect(j.command).toEqual(["/bin/bash"]);
  expect(j.wsPath).toBe("/v1/apps/myapp/exec");
  await b.cleanup();
});

test("exec-ticket route: default command is /bin/sh when omitted", async () => {
  const b = await boot();
  const res = await post(b.app, "/v1/apps/myapp/exec-ticket", "alice", {});
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).command).toEqual(["/bin/sh"]);
  await b.cleanup();
});

test("exec-ticket route: a DATABASE is 409 with the plan's rationale (psql is db proxy's job)", async () => {
  const b = await boot();
  const res = await post(b.app, "/v1/apps/mydb/exec-ticket", "alice", {});
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).error).toContain("apps only");
  await b.cleanup();
});

test("exec-ticket route: a non-member is 403 (exec is above viewer); an unknown app is 404", async () => {
  const b = await boot();
  expect((await post(b.app, "/v1/apps/myapp/exec-ticket", "bob", {})).status).toBe(403);
  expect((await post(b.app, "/v1/apps/ghost/exec-ticket", "alice", {})).status).toBe(404);
  await b.cleanup();
});

test("exec-ticket route: a malformed command (not string[]) is 400", async () => {
  const b = await boot();
  expect((await post(b.app, "/v1/apps/myapp/exec-ticket", "alice", { command: "sh" })).status).toBe(400);
  expect((await post(b.app, "/v1/apps/myapp/exec-ticket", "alice", { command: [] })).status).toBe(400);
  await b.cleanup();
});

// ---- the exec WS bridge (raw upgrades) ---------------------------------------------------------

test("bridge: a redeemed exec ticket upgrades (101); a replay is rejected (401)", async () => {
  const b = await boot();
  const { ticket } = await b.tickets.issue("myapp", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  const first = await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${ticket}`);
  expect(first.status).toContain("101");
  const second = await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${ticket}`);
  expect(second.status).toContain("401"); // spent
  first.socket.destroy();
  second.socket.destroy();
  await b.cleanup();
});

test("bridge: a ticket for one app cannot exec another (401); missing ticket 401; wrong path 404", async () => {
  const b = await boot();
  const { ticket } = await b.tickets.issue("myapp", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  expect((await rawUpgrade(b.ws.baseUrl, `/v1/apps/otherapp/exec?ticket=${ticket}`)).status).toContain("401");
  expect((await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec`)).status).toContain("401");
  expect((await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/socket`)).status).toContain("404");
  await b.cleanup();
});

test("bridge: a TUNNEL-kind ticket cannot open the exec path (401 — kind mismatch)", async () => {
  const b = await boot();
  const { ticket } = await b.tickets.issue("myapp", "alice@example.com"); // kind defaults to 'tunnel'
  expect((await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${ticket}`)).status).toContain("401");
  await b.cleanup();
});

test("bridge: exec on a database ticket is 409 (type guard, even past redemption)", async () => {
  const b = await boot();
  // Craft an exec ticket bound to the DB (bypassing the route's 409) to prove the handler's own guard.
  const { ticket } = await b.tickets.issue("mydb", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  expect((await rawUpgrade(b.ws.baseUrl, `/v1/apps/mydb/exec?ticket=${ticket}`)).status).toContain("409");
  await b.cleanup();
});

test("bridge: no ready pod → 502", async () => {
  const b = await boot({ execNoPod: true });
  const { ticket } = await b.tickets.issue("myapp", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  expect((await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${ticket}`)).status).toContain("502");
  await b.cleanup();
});

test("bridge: compute off (kube undefined) → 501 after redeeming", async () => {
  const b = await boot({ noKube: true });
  const { ticket } = await b.tickets.issue("myapp", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  expect((await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${ticket}`)).status).toContain("501");
  await b.cleanup();
});

test("bridge: per-user concurrent cap — a session over the limit is refused (503), freed on close", async () => {
  const b = await boot({ maxExecPerUser: 1 });
  const t1 = await b.tickets.issue("myapp", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  const t2 = await b.tickets.issue("myapp", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  const first = await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${t1.ticket}`);
  expect(first.status).toContain("101");
  const second = await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${t2.ticket}`);
  expect(second.status).toContain("503");
  first.socket.destroy();
  await sleep(50);
  const t3 = await b.tickets.issue("myapp", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  const third = await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${t3.ticket}`);
  expect(third.status).toContain("101"); // slot freed
  third.socket.destroy();
  await b.cleanup();
});

test("bridge: idle timeout tears the session down (onClose reason 'idle', with the command)", async () => {
  let closed: ExecStats | undefined;
  const b = await boot({ idleTimeoutMs: 100, onClose: (s) => (closed = s) });
  const { ticket } = await b.tickets.issue("myapp", "alice@example.com", { kind: "exec", command: ["/bin/sh"] });
  const up = await rawUpgrade(b.ws.baseUrl, `/v1/apps/myapp/exec?ticket=${ticket}`);
  expect(up.status).toContain("101");
  await sleep(200); // no traffic → the idle timer fires
  expect(closed?.reason).toBe("idle");
  expect(closed?.command).toEqual(["/bin/sh"]);
  up.socket.destroy();
  await b.cleanup();
});
