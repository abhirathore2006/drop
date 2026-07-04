import { test, expect } from "bun:test";
import { UptimePoller, type UptimeTarget, type HttpProbe, type TcpProbe } from "./uptime.ts";

const targets: UptimeTarget[] = [
  { name: "site1", type: "site", namespace: null, runtimeState: "running", scaleMin: 0, keepWarm: false },
  { name: "app-min1", type: "app", namespace: "ns", runtimeState: "running", scaleMin: 1, keepWarm: false },
  { name: "app-warm", type: "app", namespace: "ns", runtimeState: "running", scaleMin: 0, keepWarm: true },
  { name: "app-zero", type: "app", namespace: "ns", runtimeState: "running", scaleMin: 0, keepWarm: false },
  { name: "app-stopped", type: "app", namespace: "ns", runtimeState: "stopped", scaleMin: 1, keepWarm: false },
  { name: "db1", type: "database", namespace: "ns", runtimeState: "running", scaleMin: 0, keepWarm: false },
];

interface Recorded {
  name: string;
  minute: Date;
  ok: boolean;
  latencyMs: number;
  status: number;
}

function fakes(opts: { httpProbe?: HttpProbe; tcpProbe?: TcpProbe; edgeInternalUrl?: string; probeDatabases?: boolean } = {}) {
  const recorded: Recorded[] = [];
  const poller = new UptimePoller({
    meta: { listUptimeTargets: async () => targets },
    metrics: { recordUptime: async (name, minute, r) => void recorded.push({ name, minute, ...r }) },
    baseDomain: "drop.example.com",
    edgeInternalUrl: "edgeInternalUrl" in opts ? opts.edgeInternalUrl : "http://edge.internal",
    probeDatabases: opts.probeDatabases ?? true,
    now: () => new Date("2026-07-04T10:00:30Z"),
    httpProbe: opts.httpProbe ?? (async () => ({ ok: true, status: 200, latencyMs: 12 })),
    tcpProbe: opts.tcpProbe ?? (async () => ({ ok: true, latencyMs: 5 })),
  });
  return { poller, recorded };
}

test("probeKind: gating rules (site always; app iff min≥1 or keep_warm and not stopped; db iff probeDatabases)", () => {
  const { poller } = fakes({ probeDatabases: true });
  const kind = (n: string) => poller.probeKind(targets.find((t) => t.name === n)!);
  expect(kind("site1")).toBe("http");
  expect(kind("app-min1")).toBe("http");
  expect(kind("app-warm")).toBe("http");
  expect(kind("app-zero")).toBeNull(); // scale-to-zero without keep_warm — a probe would wake it
  expect(kind("app-stopped")).toBeNull(); // intentionally offline
  expect(kind("db1")).toBe("tcp");
});

test("probeKind: databases are skipped when not in-cluster reachable", () => {
  const { poller } = fakes({ probeDatabases: false });
  expect(poller.probeKind(targets.find((t) => t.name === "db1")!)).toBeNull();
});

test("sweep: probes exactly the qualifying targets + records outcomes at the floored minute", async () => {
  const { poller, recorded } = fakes();
  const results = await poller.sweep();
  expect(recorded.map((r) => r.name).sort()).toEqual(["app-min1", "app-warm", "db1", "site1"]);
  // db1 is a TCP probe → status 0; the minute is floored to the top of the minute.
  const db = recorded.find((r) => r.name === "db1")!;
  expect(db.status).toBe(0);
  expect(db.ok).toBe(true);
  expect(db.minute.toISOString()).toBe("2026-07-04T10:00:00.000Z");
  expect(results).toHaveLength(4);
});

test("sweep: passes the edge origin + Host header; records HTTP status + ok", async () => {
  const seen: { origin: string; host: string }[] = [];
  const httpProbe: HttpProbe = async (t) => {
    seen.push(t);
    // app-min1 is up (200); site1 is a 5xx (down); app-warm times out (status 0, ok false).
    if (t.host.startsWith("app-min1.")) return { ok: true, status: 200, latencyMs: 11 };
    if (t.host.startsWith("site1.")) return { ok: false, status: 503, latencyMs: 8 };
    return { ok: false, status: 0, latencyMs: 5000 };
  };
  const { poller, recorded } = fakes({ httpProbe });
  await poller.sweep();
  expect(seen.every((s) => s.origin === "http://edge.internal")).toBe(true);
  expect(seen.some((s) => s.host === "app-min1.drop.example.com")).toBe(true);
  const up = recorded.find((r) => r.name === "app-min1")!;
  const down = recorded.find((r) => r.name === "site1")!;
  const timeout = recorded.find((r) => r.name === "app-warm")!;
  expect([up.ok, up.status]).toEqual([true, 200]);
  expect([down.ok, down.status]).toEqual([false, 503]);
  expect([timeout.ok, timeout.status]).toEqual([false, 0]);
});

test("sweep: no edge origin → HTTP probes skipped; databases (TCP) still run", async () => {
  const { poller, recorded } = fakes({ edgeInternalUrl: undefined });
  await poller.sweep();
  expect(recorded.map((r) => r.name)).toEqual(["db1"]); // only the TCP target
});
