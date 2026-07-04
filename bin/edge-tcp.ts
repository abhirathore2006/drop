import { loadTcpConfig } from "../src/config.ts";
import { StaticRouteSource, type TcpRouteSource, type TcpTarget } from "../src/edge-tcp/route-source.ts";
import { MetastoreRouteSource } from "../src/edge-tcp/meta-source.ts";
import { makeDb } from "../src/db/db.ts";
import { createEdgeTcpServer } from "../src/edge-tcp/server.ts";

const cfg = loadTcpConfig();

// A2b: when a database is configured, route from the metastore (`tcp_endpoints`, read-only — the API
// owns migrations + writes), so `drop expose` / `drop unexpose` take effect with no router restart.
// Without a DB the env-only StaticRouteSource remains the fallback (tests + static local dev). Read
// the DB URL + base domain straight from env so this entry stays decoupled from loadConfig's S3/DB
// requirements (same posture as the rest of loadTcpConfig).
let source: TcpRouteSource;
const databaseUrl = process.env.DROP_DATABASE_URL;
if (databaseUrl) {
  const { db } = makeDb(databaseUrl);
  const baseDomain = process.env.DROP_BASE_DOMAIN ?? "drop.example.com";
  source = new MetastoreRouteSource(db, { baseDomain });
  console.log(`drop-edge-tcp routing from metastore (base domain *.${baseDomain})`);
} else {
  // A2a static route table: {"sni": {"app.drop.example.com": {"host":"app.ns.svc","port":443,"workload":"app"}},
  //                          "port": {"7000": {"host":"redis.ns.svc","port":6379,"workload":"redis"}}}
  const staticSource = new StaticRouteSource();
  if (cfg.staticRoutesJson) {
    try {
      const parsed = JSON.parse(cfg.staticRoutesJson) as {
        sni?: Record<string, TcpTarget>;
        port?: Record<string, TcpTarget>;
      };
      for (const [name, t] of Object.entries(parsed.sni ?? {})) staticSource.setSni(name, t);
      for (const [p, t] of Object.entries(parsed.port ?? {})) staticSource.setPort(Number(p), t);
    } catch (e) {
      console.error(`DROP_TCP_STATIC_ROUTES is not valid JSON: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  source = staticSource;
  console.log("drop-edge-tcp routing from the static env route table (DROP_TCP_STATIC_ROUTES)");
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
