import { loadTcpConfig } from "../src/config.ts";
import { StaticRouteSource, type TcpTarget } from "../src/edge-tcp/route-source.ts";
import { createEdgeTcpServer } from "../src/edge-tcp/server.ts";

const cfg = loadTcpConfig();

// A2a routes from a static JSON table; A2b replaces this with the metastore-backed source
// (reads `tcp_endpoints` with the edge's read-only posture). Shape:
//   {"sni":  {"app.drop.example.com": {"host":"app.ns.svc","port":443,"workload":"app"}},
//    "port": {"7000": {"host":"redis.ns.svc","port":6379,"workload":"redis"}}}
const source = new StaticRouteSource();
if (cfg.staticRoutesJson) {
  try {
    const parsed = JSON.parse(cfg.staticRoutesJson) as {
      sni?: Record<string, TcpTarget>;
      port?: Record<string, TcpTarget>;
    };
    for (const [name, t] of Object.entries(parsed.sni ?? {})) source.setSni(name, t);
    for (const [p, t] of Object.entries(parsed.port ?? {})) source.setPort(Number(p), t);
  } catch (e) {
    console.error(`DROP_TCP_STATIC_ROUTES is not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }
}

const server = createEdgeTcpServer({
  source,
  sharedPorts: cfg.sharedPorts,
  dynamicPorts: cfg.dynamicPorts,
  idleTimeoutMs: cfg.idleTimeoutMs,
  maxConnsPerWorkload: cfg.maxConnsPerWorkload,
  handshakeTimeoutMs: cfg.handshakeTimeoutMs,
  // G2 seam: one line per closed connection with the final byte counts.
  onClose: (s) =>
    console.log(`drop-edge-tcp close workload=${s.workload} in=${s.bytesIn} out=${s.bytesOut} durMs=${s.durationMs} reason=${s.reason}`),
});

const infos = await server.listen();
for (const i of infos) console.log(`drop-edge-tcp listening on :${i.port} (${i.kind})`);
const dyn = cfg.dynamicPorts.length;
console.log(`drop-edge-tcp ready — ${cfg.sharedPorts.length} shared port(s), ${dyn} dynamic port(s)`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
