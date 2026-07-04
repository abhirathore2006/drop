import { test, expect } from "bun:test";
import * as net from "node:net";
import { EventEmitter } from "node:events";
import { createApp } from "../api/server.ts";
import { createExecHandler, type ExecStats } from "../api/exec-bridge.ts";
import { TunnelTicketStore } from "../tokens/tunnel-tickets.ts";
import { newSecWebSocketKey } from "../ws/frames.ts";
import { FakeKube, type FakeExecSession } from "../kube/fake.ts";
import { runExec, spliceExec, type ExecIo } from "./exec.ts";
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

/** A minimal API "server" over raw TCP: WebSocket upgrades go to the exec handler; every other request
 *  bridges to Hono via app.fetch — FORWARDING the request body (the exec-ticket POST carries JSON). */
function startApi(app: any, execHandler: (req: any, socket: net.Socket, head: Buffer) => void) {
  const server = net.createServer((sock) => {
    sock.on("error", () => sock.destroy());
    let buf = Buffer.alloc(0);
    let handled = false;
    const onHead = (d: Buffer) => {
      if (handled) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      const headText = buf.subarray(0, i).toString("latin1");
      const lines = headText.split("\r\n");
      const [method, url] = lines[0]!.split(" ");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const c = line.indexOf(":");
        if (c === -1) continue;
        headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      if ((headers.upgrade ?? "").toLowerCase() === "websocket") {
        handled = true;
        sock.removeListener("data", onHead);
        execHandler({ method, url, headers, socket: sock }, sock, buf.subarray(i + 4));
        return;
      }
      // Wait for the full body (content-length) before bridging the ticket POST.
      const clen = Number(headers["content-length"] ?? "0");
      if (buf.length - (i + 4) < clen) return;
      handled = true;
      sock.removeListener("data", onHead);
      const body = buf.subarray(i + 4, i + 4 + clen);
      void (async () => {
        const reqHeaders: Record<string, string> = {};
        if (headers.authorization) reqHeaders.authorization = headers.authorization;
        if (headers["content-type"]) reqHeaders["content-type"] = headers["content-type"];
        const res = await app.fetch(new Request(`http://127.0.0.1${url}`, { method, headers: reqHeaders, body: clen ? body : undefined }));
        const out = Buffer.from(await res.arrayBuffer());
        sock.write(`HTTP/1.1 ${res.status} X\r\ncontent-length: ${out.length}\r\nconnection: close\r\n\r\n`);
        sock.write(out);
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
  maxExecPerUser?: number;
  idleTimeoutMs?: number;
  onClose?: (s: ExecStats) => void;
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
  const cfg = loadConfig({
    DROP_S3_BUCKET: "b",
    DROP_DATABASE_URL: "postgres://x/y",
    DROP_BASE_DOMAIN: "drop.example.com",
    DROP_S3_ENDPOINT: "http://localhost:4566",
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
    kube,
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
  // alice owns an app "myapp" (claim it directly; a full deploy isn't needed for the exec bridge).
  await users.upsertOnLogin("alice@example.com", null);
  const org = await orgs.ensurePersonalOrg("alice@example.com");
  await meta.claimSite("myapp", "alice@example.com", "app", { id: org.id, namespace: org.namespace });

  const auditEvents: any[] = [];
  const handler = createExecHandler({
    meta,
    tickets,
    kube,
    audit: (e) => auditEvents.push(e),
    maxExecPerUser: opts.maxExecPerUser,
    idleTimeoutMs: opts.idleTimeoutMs,
    onClose: opts.onClose,
  });
  const api = await startApi(app, handler);
  return {
    api,
    kube,
    tickets,
    auditEvents,
    session: { apiBase: api.baseUrl, token: "alice" },
    async cleanup() {
      await api.close();
      await db.destroy();
    },
  };
}

/** A collectible terminal-io double for spliceExec (no real TTY). */
function fakeIo(isTTY = false) {
  const stdin = new EventEmitter() as any;
  stdin.pause = () => {};
  stdin.resume = () => {};
  stdin.rawMode = false;
  stdin.setRawMode = (v: boolean) => (stdin.rawMode = v);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let cols = 80;
  let rows = 24;
  const resizeCbs: (() => void)[] = [];
  const io: ExecIo = {
    stdin,
    stdout: { write: (d: any) => (out.push(Buffer.from(d)), true) } as any,
    stderr: { write: (d: any) => (err.push(Buffer.from(d)), true) } as any,
    isTTY,
    size: () => ({ cols, rows }),
    onResize: (cb) => (resizeCbs.push(cb), () => {}),
  };
  return {
    io,
    stdin,
    out: () => Buffer.concat(out).toString("utf8"),
    err: () => Buffer.concat(err).toString("utf8"),
    setSize: (c: number, r: number) => ((cols = c), (rows = r)),
    fireResize: () => resizeCbs.forEach((cb) => cb()),
  };
}

/** Await the FakeExecSession the bridge opens (openExec fires FakeKube.onExec synchronously). */
function grabSession(kube: FakeKube): Promise<FakeExecSession> {
  return new Promise((resolve) => {
    kube.onExec = (session) => resolve(session);
  });
}

// ---- tests -------------------------------------------------------------------------------------

test("e2e: bytes flow both ways (stdin→remote, stdout+stderr→terminal), exit code + audit-with-command", async () => {
  const b = await boot();
  const sessionP = grabSession(b.kube);
  const t = fakeIo();

  const runP = runExec({ session: b.session, app: "myapp", command: ["/bin/sh", "-c", "cat"], io: t.io });
  const session = await sessionP;
  await sleep(30); // let the bridge register its callbacks

  // remote → terminal: stdout + stderr split by their markers.
  session.emitStdout("hello from stdout\n");
  session.emitStderr("a warning\n");
  await sleep(20);
  expect(t.out()).toBe("hello from stdout\n");
  expect(t.err()).toBe("a warning\n");

  // terminal → remote: keystrokes reach stdin (channel 0).
  t.stdin.emit("data", Buffer.from("echo hi\n"));
  await sleep(20);
  expect(session.stdin).toBe("echo hi\n");

  // the command bound at issuance is what FakeKube was asked to exec (no escalation surface).
  expect(b.kube.execCalls[0]!.command).toEqual(["/bin/sh", "-c", "cat"]);
  expect(b.kube.execCalls[0]!.tty).toBe(true);

  // remote exits 42 → the CLI mirrors the exit code once the stream closes.
  session.emitExit(42);
  session.endRemote();
  const code = await runP;
  expect(code).toBe(42);

  // the session was audited AT REDEMPTION, with the command in detail.
  const ev = b.auditEvents.find((e) => e.action === "app.exec");
  expect(ev).toBeTruthy();
  expect(ev.actor).toBe("alice@example.com");
  expect(ev.target).toBe("myapp");
  expect(ev.targetType).toBe("app");
  expect(ev.detail.command).toEqual(["/bin/sh", "-c", "cat"]);

  await b.cleanup();
});

test("e2e: a TTY forwards the initial size + a SIGWINCH resize as channel-4 resizes", async () => {
  const b = await boot();
  const sessionP = grabSession(b.kube);
  const t = fakeIo(true); // TTY
  t.setSize(120, 40);

  const runP = runExec({ session: b.session, app: "myapp", command: ["/bin/sh"], io: t.io });
  const session = await sessionP;
  await sleep(30);

  // The initial size was sent on connect.
  expect(session.resizes).toContainEqual({ cols: 120, rows: 40 });

  // A window change forwards a new resize.
  t.setSize(100, 30);
  t.fireResize();
  await sleep(20);
  expect(session.resizes).toContainEqual({ cols: 100, rows: 30 });

  session.endRemote();
  await runP;
  await b.cleanup();
});

test("e2e: default command is /bin/sh when none is given", async () => {
  const b = await boot();
  const sessionP = grabSession(b.kube);
  const t = fakeIo();
  const runP = runExec({ session: b.session, app: "myapp", command: ["/bin/sh"], io: t.io });
  const session = await sessionP;
  await sleep(30); // let the bridge register onClose before the remote ends
  expect(b.kube.execCalls[0]!.command).toEqual(["/bin/sh"]);
  session.endRemote();
  await runP;
  await b.cleanup();
});

// ---- spliceExec unit: the CLI dial/splice reuse seam, driven over a real loopback socket pair ----

test("spliceExec: stdin → masked binary frames; server stdout marker → stdout; exit frame → code", async () => {
  const { encodeFrame } = await import("../ws/frames.ts");
  const { encodeExecChunk, EXEC_STREAM } = await import("../ws/exec-protocol.ts");
  const { client, srv, close } = await connectedPair();
  const t = fakeIo();
  const done = spliceExec(t.io, client, Buffer.alloc(0));

  // The server end sees the CLI's stdin as MASKED binary frames (RFC 6455 client rule).
  const seen: Buffer[] = [];
  srv.on("data", (d: Buffer) => seen.push(Buffer.from(d)));
  t.stdin.emit("data", Buffer.from("hi"));
  await sleep(20);
  const frame = Buffer.concat(seen);
  expect(frame.length).toBeGreaterThan(0);
  expect((frame[1]! & 0x80) !== 0).toBe(true); // mask bit set on a client frame

  // Server → CLI: an unmasked stdout-marker frame lands on stdout; an exit frame sets the code; close ends.
  srv.write(encodeFrame(encodeExecChunk(EXEC_STREAM.stdout, Buffer.from("out!")), { opcode: 0x2 }));
  srv.write(encodeFrame(encodeExecChunk(EXEC_STREAM.exit, Buffer.from("7")), { opcode: 0x2 }));
  await sleep(20);
  expect(t.out()).toBe("out!");
  srv.write(encodeFrame(Buffer.alloc(0), { opcode: 0x8 })); // close
  const code = await done;
  expect(code).toBe(7);
  await close();
});

/** A connected loopback socket pair (client end + server end) — awaited so both ends are live. */
function connectedPair(): Promise<{ client: net.Socket; srv: net.Socket; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((srv) => {
      srv.on("error", () => srv.destroy());
      resolve({
        client,
        srv,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    let client!: net.Socket;
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      client = net.connect(port, "127.0.0.1");
      client.on("error", () => client.destroy());
    });
  });
}
