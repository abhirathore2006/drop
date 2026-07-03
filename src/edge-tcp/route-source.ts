/** The injected routing port for the L4 TCP router. The router itself is transport-only
 *  (SNI peek / PG preamble / splice); WHERE a connection goes is decided here. A2a ships an
 *  in-memory `StaticRouteSource` (tests + local dev); A2b adds a metastore-backed source that
 *  reads `tcp_endpoints` with the same read-only posture the edge uses for sites. */

/** Where a resolved connection is spliced to, plus the workload it belongs to (the key the
 *  per-workload concurrent cap and the byte counters are attributed to). */
export interface TcpTarget {
  /** Upstream host — in-cluster Service DNS in prod (`<name>.<ns>.svc`), 127.0.0.1 in tests. */
  host: string;
  /** Upstream TCP port. */
  port: number;
  /** The workload this route belongs to (cap key + `onClose` attribution). */
  workload: string;
}

/** The router's only dependency on the outside world. Both methods are async so the A2b
 *  metastore source can do a DB lookup; the static source resolves synchronously. */
export interface TcpRouteSource {
  /** Resolve a TLS SNI hostname (e.g. `app.drop.example.com`) to its target, or null if the
   *  name is unknown / not exposed. Case-insensitive on the SNI (hostnames are). */
  resolveSni(name: string): Promise<TcpTarget | null>;
  /** Resolve a dynamic (per-workload) port to its target, or null if the port isn't allocated.
   *  The router passes the port the client actually connected to (no protocol parsing). */
  resolvePort(port: number): Promise<TcpTarget | null>;
}

/** A map-backed `TcpRouteSource` for tests and local dev. Mutable so a test can register a
 *  route AFTER binding an ephemeral port (the real bound port is only known post-listen). */
export class StaticRouteSource implements TcpRouteSource {
  private readonly sni = new Map<string, TcpTarget>();
  private readonly port = new Map<number, TcpTarget>();

  constructor(init?: { sni?: Record<string, TcpTarget>; port?: Record<number | string, TcpTarget> }) {
    for (const [name, t] of Object.entries(init?.sni ?? {})) this.setSni(name, t);
    for (const [p, t] of Object.entries(init?.port ?? {})) this.setPort(Number(p), t);
  }

  /** Register (or replace) an SNI route. The name is lowercased — SNI is case-insensitive. */
  setSni(name: string, target: TcpTarget): this {
    this.sni.set(name.toLowerCase(), target);
    return this;
  }

  /** Register (or replace) a dynamic-port route. */
  setPort(port: number, target: TcpTarget): this {
    this.port.set(port, target);
    return this;
  }

  resolveSni(name: string): Promise<TcpTarget | null> {
    return Promise.resolve(this.sni.get(name.toLowerCase()) ?? null);
  }

  resolvePort(port: number): Promise<TcpTarget | null> {
    return Promise.resolve(this.port.get(port) ?? null);
  }
}
