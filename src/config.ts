import { GOTRUE_IMAGE } from "./auth-resource/gotrue.ts";

export interface Config {
  httpPort: number;
  baseDomain: string;
  s3Bucket: string;
  s3Endpoint?: string; // set for Floci / MinIO; omit for real AWS
  s3Region: string;
  s3KeyId?: string;
  s3Secret?: string;
  databaseUrl: string; // postgres connection string (required)
  googleClientId?: string; // (J2) legacy alias — DROP_GOOGLE_CLIENT_ID; oidcClientId falls back to it
  googleClientSecret?: string; // (J2) legacy alias — DROP_GOOGLE_CLIENT_SECRET; oidcClientSecret falls back to it
  allowedDomains: string[]; // legacy DROP_ALLOWED_DOMAINS; oidcAllowedDomains falls back to it. empty = any account from the issuer
  allowedEmails: string[]; // empty = no per-email restriction; else only these (lowercased)
  admins: string[]; // emails that can see/manage all sites (lowercased)
  // --- (J2) Generic OIDC platform login -------------------------------------------------
  // Google is just the DEFAULT issuer: existing Google deployments keep working with ZERO
  // migration because the issuer defaults to accounts.google.com and DROP_OIDC_CLIENT_ID/SECRET
  // fall back to the legacy DROP_GOOGLE_CLIENT_ID/SECRET. Point DROP_OIDC_ISSUER at Okta / Entra /
  // Keycloak / Authentik to switch providers. ONE provider per deployment — multi-IdP is
  // deliberately REFUSED here (it's enterprise-SSO scope creep per Plan-v5 J2); a deployment that
  // needs two IdPs runs two Drop instances.
  oidcIssuer: string; // DROP_OIDC_ISSUER — discovery base (/.well-known/openid-configuration). Default https://accounts.google.com
  oidcClientId?: string; // DROP_OIDC_CLIENT_ID, else DROP_GOOGLE_CLIENT_ID (precedence: OIDC wins)
  oidcClientSecret?: string; // DROP_OIDC_CLIENT_SECRET, else DROP_GOOGLE_CLIENT_SECRET
  oidcScopes: string; // DROP_OIDC_SCOPES — default "openid email profile"
  oidcEmailClaim: string; // DROP_OIDC_EMAIL_CLAIM — claim holding the email principal (default "email")
  oidcNameClaim: string; // DROP_OIDC_NAME_CLAIM — claim holding the display name (default "name")
  oidcAllowedDomains: string[]; // DROP_OIDC_ALLOWED_DOMAINS, else DROP_ALLOWED_DOMAINS. empty = any domain
  oidcGroupsClaim?: string; // DROP_OIDC_GROUPS_CLAIM — claim carrying the user's groups (array or space-joined string)
  oidcRequiredGroup?: string; // DROP_OIDC_REQUIRED_GROUP — when set, login requires this group in the groups claim
  oidcDisplayName: string; // DROP_OIDC_DISPLAY_NAME — provider name shown on the login button (default derived from the issuer host)
  breakGlassAdmin?: string; // DROP_BREAK_GLASS_ADMIN — "email:saltHex:hashHex" (scrypt). Enables POST /auth/break-glass ONLY when set. No signup/reset.
  publicUrl: string; // externally-reachable API base, for the OAuth callback
  sessionSecret: string; // HS256 key for Drop session tokens (required unless devAuth)
  devAuth: boolean;
  maxUploadBytes: number;
  maxFiles: number;
  keepVersions: number;
  maxWorkloadsPerOrg: number; // cap on sites+apps+databases an org may claim (0 = unlimited)
  blockedEgressCidrs: string[]; // in-cluster/control-plane CIDRs excluded from the tenant HTTPS egress allowlist (MUST cover the live pod+service CIDRs)
  dbBackupRoleArn?: string; // prod: IRSA role for CNPG database backups to S3 (omit locally — Floci uses static creds)
  dbBackupEndpoint?: string; // in-cluster S3 endpoint for CNPG backups (e.g. local Floci on the pod network). Distinct from s3Endpoint, which is the API's host-side view. Unset in prod → real AWS S3.
  dbBackupEgressCidr?: string; // CIDR the DB pod may egress to for the object store on its (non-443) port (local only; prod S3 is 443, already allowed by the tenant policy)
  dbExtensionAllowlist: string[]; // (I3) Postgres extensions a tenant may request at db-create (default pgvector,pg_trgm,pgcrypto,citext)
  bucketAppEndpoint?: string; // I1: in-cluster S3 endpoint injected into apps bound to a bucket (reachable from a tenant pod). Falls back to dbBackupEndpoint ?? s3Endpoint; unset in prod → real AWS S3.
  edgeDiskCacheDir?: string; // edge: where to cache asset bytes on disk (off if unset)
  edgeDiskCacheBytes: number; // edge: disk cache budget
  interceptorUrl?: string; // edge: KEDA HTTP interceptor base URL — type=app hostnames proxy here (off if unset)
  wsMaxPerHost: number; // edge: per-host concurrent WebSocket-upgrade cap (0 falls back to the default)
  wsIdleTimeoutMs: number; // edge: WS idle timeout — destroy both sockets after this long with no bytes
  wsDirect: boolean; // edge: DROP_WS_DIRECT — bypass the interceptor, dial the app Service directly (wake shim)
  // --- edge metrics + uptime (G2 / G2b) ---
  metricsFlushIntervalMs: number; // edge: how often the in-process traffic collector flushes to traffic_minutes (default 15s)
  metricsRetentionDays: number; // api: retention for traffic_minutes + uptime_checks; swept in housekeeping (default 30d)
  uptimeIntervalMs: number; // api: how often the synthetic uptime poller sweeps (default 60s)
  edgeInternalUrl?: string; // api: the edge origin the uptime poller GETs (Host-routed). Unset → HTTP probes skipped (DB TCP still runs)
  docsDir: string; // api: static docs site served at /docs (relative to cwd)
  cliDir: string; // api: dir holding the CLI bundles served at /cli (relative to cwd)
  // --- app secrets backend (chosen at deploy time) ---
  secretBackend: "kube" | "aws"; // "kube" = write the <app>-secret Secret directly; "aws" = AWS Secrets Manager + ESO
  secretManagerEndpoint?: string; // local Floci endpoint for the SM API (host-side); omit for real AWS
  secretManagerRegion: string;
  secretManagerKeyId?: string; // static creds for the SM client (Floci: "test"); omit in prod → IRSA
  secretManagerSecret?: string;
  secretStoreName: string; // the ESO ClusterSecretStore the app ExternalSecrets reference (e.g. "floci")
  secretPathPrefix: string; // SM name prefix → drop/<owner>/<app>/<KEY>
  // Image push (`drop push` / `drop deploy --build` → PUT /v1/apps/:name/image). The CLI uploads a
  // `docker save` tarball; the backend makes it pullable by the cluster. "containerd" imports into
  // the local k3s node's containerd (local dev); "registry" pushes to a registry like ECR (prod).
  imageBackend: "containerd" | "registry";
  imageRuntime: string; // host container CLI that can reach the k3s node (containerd backend): "podman" | "docker"
  imageK3sContainer: string; // the container running k3s (containerd backend), e.g. "k3s"
  imageContainerdSock: string; // k3s containerd socket path inside that container
  imageRegistry?: string; // registry host/repo prefix for the "registry" backend, e.g. <acct>.dkr.ecr.<region>.amazonaws.com/drop-apps
  imageRegistryPullSecret?: string; // name of a pre-provisioned imagePullSecret in the tenant ns (registry backend)
  imageMaxBytes: number; // reject an image-push upload larger than this (default 2 GiB) — DoS bound
  // --- L4 / TCP expose (A2b) ---
  tcpPortFrom: number; // DROP_TCP_PORT_RANGE low bound — the dynamic per-workload port pool (default 7000)
  tcpPortTo: number; // DROP_TCP_PORT_RANGE high bound (default 7099); allocation is lowest-free in [from,to], exhaustion → 409
  tcpLbHost: string; // DROP_TCP_LB_HOST — host in a port-mode connect string (<lb-host>:<port>); defaults to baseDomain
  tcpSharedPorts: TcpSharedPort[]; // DROP_TCP_SHARED_PORTS — used to derive the sni-mode connect port per protocol (default 5432:postgres)
  edgeTcpNamespace: string; // DROP_EDGE_TCP_NAMESPACE — where the edge-tcp Service lives (patched on port expose) + the NetworkPolicy source ns (default drop-system)
  edgeTcpService: string; // DROP_EDGE_TCP_SERVICE — the edge-tcp Service name whose port list the API patches on port expose (default drop-edge-tcp)
  // --- previews (E1) ---
  previewSweepIntervalMs: number; // DROP_PREVIEW_SWEEP_INTERVAL_MS — how often the API sweeps expired previews (default 5 min)
  // --- managed auth resource (K1) ---
  authEngineImage: string; // DROP_AUTH_ENGINE_IMAGE — the pinned GoTrue image (air-gap: mirror + override). Default from src/auth-resource/gotrue.ts
  authRateLimit: number; // DROP_AUTH_RATE_LIMIT — per-IP token budget for the sensitive auth POST paths at the edge (default 10; 0 disables)
  authRateWindowMs: number; // DROP_AUTH_RATE_WINDOW_MS — the refill window for the auth rate limit (default 60000)
  // --- db:proxy authenticated tunnel (A3) ---
  tunnelDirect: boolean; // DROP_TUNNEL_DIRECT — dial the DB Service DNS directly (in-cluster API posture); off → local API can't reach the DB, tunnel 501s
  tunnelTicketTtlMs: number; // DROP_TUNNEL_TICKET_TTL_MS — single-use tunnel-ticket lifetime (default 60s)
  tunnelIdleTimeoutMs: number; // DROP_TUNNEL_IDLE_TIMEOUT_MS — destroy an idle tunnel after this long with no bytes (default 5 min)
  maxTunnelsPerUser: number; // DROP_MAX_TUNNELS_PER_USER — per-user concurrent-tunnel cap (default 5, in-process)
  // --- `drop exec` interactive shell (J3; reuses the tunnel-ticket TTL) ---
  execIdleTimeoutMs: number; // DROP_EXEC_IDLE_TIMEOUT_MS — destroy an idle exec session after this long with no bytes (default 15 min)
  maxExecPerUser: number; // DROP_MAX_EXEC_PER_USER — per-user concurrent-exec-session cap (default 3, in-process)
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const s3Bucket = env.DROP_S3_BUCKET ?? "";
  if (!s3Bucket) throw new Error("DROP_S3_BUCKET is required");
  const databaseUrl = env.DROP_DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("DROP_DATABASE_URL is required");
  return {
    httpPort: Number(env.DROP_HTTP_PORT ?? "8080"),
    baseDomain: env.DROP_BASE_DOMAIN ?? "drop.example.com",
    s3Bucket,
    s3Endpoint: env.DROP_S3_ENDPOINT || undefined,
    s3Region: env.DROP_S3_REGION ?? "us-east-1",
    s3KeyId: env.DROP_S3_KEY_ID || undefined,
    s3Secret: env.DROP_S3_SECRET || undefined,
    databaseUrl,
    googleClientId: env.DROP_GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.DROP_GOOGLE_CLIENT_SECRET || undefined,
    allowedDomains: (env.DROP_ALLOWED_DOMAINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // (J2) OIDC provider — Google is the default issuer; client id/secret + allowed-domains fall
    // back to the legacy DROP_GOOGLE_* / DROP_ALLOWED_DOMAINS vars so existing deployments are untouched.
    oidcIssuer: env.DROP_OIDC_ISSUER || "https://accounts.google.com",
    oidcClientId: env.DROP_OIDC_CLIENT_ID || env.DROP_GOOGLE_CLIENT_ID || undefined,
    oidcClientSecret: env.DROP_OIDC_CLIENT_SECRET || env.DROP_GOOGLE_CLIENT_SECRET || undefined,
    oidcScopes: env.DROP_OIDC_SCOPES || "openid email profile",
    oidcEmailClaim: env.DROP_OIDC_EMAIL_CLAIM || "email",
    oidcNameClaim: env.DROP_OIDC_NAME_CLAIM || "name",
    // `??` (not `||`) so an explicit DROP_OIDC_ALLOWED_DOMAINS="" clears the gate (any domain) even
    // when the legacy DROP_ALLOWED_DOMAINS is set — OIDC always wins when present.
    oidcAllowedDomains: (env.DROP_OIDC_ALLOWED_DOMAINS ?? env.DROP_ALLOWED_DOMAINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    oidcGroupsClaim: env.DROP_OIDC_GROUPS_CLAIM || undefined,
    oidcRequiredGroup: env.DROP_OIDC_REQUIRED_GROUP || undefined,
    oidcDisplayName: env.DROP_OIDC_DISPLAY_NAME || deriveDisplayName(env.DROP_OIDC_ISSUER || "https://accounts.google.com"),
    breakGlassAdmin: env.DROP_BREAK_GLASS_ADMIN || undefined,
    allowedEmails: (env.DROP_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    admins: (env.DROP_ADMINS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    publicUrl: (env.DROP_PUBLIC_URL ?? `http://localhost:${env.DROP_HTTP_PORT ?? "8080"}`).replace(/\/$/, ""),
    sessionSecret: env.DROP_SESSION_SECRET ?? "",
    devAuth: env.DROP_DEV_AUTH === "1",
    maxUploadBytes: Number(env.DROP_MAX_UPLOAD_BYTES ?? String(100 * 1024 * 1024)),
    maxFiles: Number(env.DROP_MAX_FILES ?? "5000"),
    keepVersions: Number(env.DROP_KEEP_VERSIONS ?? "10"),
    maxWorkloadsPerOrg: Number(env.DROP_MAX_WORKLOADS_PER_ORG ?? "0") || 0,
    // Local k3s pod/service CIDRs live in 10/8; PROD EKS must set the real ones.
    blockedEgressCidrs: (env.DROP_BLOCKED_EGRESS_CIDRS ?? "10.0.0.0/8")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    edgeDiskCacheDir: env.DROP_EDGE_DISK_CACHE || undefined,
    edgeDiskCacheBytes: Number(env.DROP_EDGE_DISK_CACHE_BYTES ?? String(5 * 1024 * 1024 * 1024)),
    interceptorUrl: env.DROP_INTERCEPTOR_URL || undefined,
    wsMaxPerHost: Number(env.DROP_WS_MAX_PER_HOST ?? "100") || 100,
    wsIdleTimeoutMs: Number(env.DROP_WS_IDLE_TIMEOUT_MS ?? String(5 * 60 * 1000)) || 5 * 60 * 1000,
    wsDirect: env.DROP_WS_DIRECT === "1",
    metricsFlushIntervalMs: Number(env.DROP_METRICS_FLUSH_INTERVAL_MS ?? "15000") || 15000,
    metricsRetentionDays: Number(env.DROP_METRICS_RETENTION_DAYS ?? "30") || 30,
    uptimeIntervalMs: Number(env.DROP_UPTIME_INTERVAL_MS ?? "60000") || 60000,
    edgeInternalUrl: env.DROP_EDGE_INTERNAL_URL || undefined,
    dbBackupRoleArn: env.DROP_DB_BACKUP_ROLE_ARN || undefined,
    dbBackupEndpoint: env.DROP_DB_BACKUP_S3_ENDPOINT || undefined,
    dbBackupEgressCidr: env.DROP_DB_BACKUP_S3_EGRESS_CIDR || undefined,
    dbExtensionAllowlist: (env.DROP_DB_EXTENSION_ALLOWLIST ?? "pgvector,pg_trgm,pgcrypto,citext")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    bucketAppEndpoint: env.DROP_BUCKET_S3_ENDPOINT || undefined,
    docsDir: env.DROP_DOCS_DIR ?? "docs",
    cliDir: env.DROP_CLI_DIR ?? "dist",
    secretBackend: env.DROP_SECRET_BACKEND === "aws" ? "aws" : "kube",
    secretManagerEndpoint: env.DROP_SECRET_MANAGER_ENDPOINT || undefined,
    secretManagerRegion: env.DROP_SECRET_MANAGER_REGION ?? env.DROP_S3_REGION ?? "us-east-1",
    secretManagerKeyId: env.DROP_SECRET_MANAGER_KEY_ID || undefined,
    secretManagerSecret: env.DROP_SECRET_MANAGER_SECRET || undefined,
    secretStoreName: env.DROP_SECRET_STORE_NAME ?? "floci",
    secretPathPrefix: env.DROP_SECRET_PATH_PREFIX ?? "drop",
    imageBackend: env.DROP_IMAGE_BACKEND === "registry" ? "registry" : "containerd",
    imageRuntime: env.DROP_IMAGE_RUNTIME ?? "podman",
    imageK3sContainer: env.DROP_K3S_CONTAINER ?? "k3s",
    imageContainerdSock: env.DROP_CONTAINERD_SOCK ?? "/run/k3s/containerd/containerd.sock",
    imageRegistry: env.DROP_IMAGE_REGISTRY || undefined,
    imageRegistryPullSecret: env.DROP_IMAGE_REGISTRY_PULL_SECRET || undefined,
    imageMaxBytes: Number(env.DROP_IMAGE_MAX_BYTES) || 2 * 1024 * 1024 * 1024,
    ...(() => {
      // L4/TCP expose (A2b). The dynamic-port pool the expose API allocates from (lowest-free wins),
      // the LB host used in port-mode connect strings, the shared-port map used to derive an sni-mode
      // connect port per protocol, and where the edge-tcp Service lives (patched on a port expose).
      const range = parsePortRange(env.DROP_TCP_PORT_RANGE ?? "7000-7099", 7000, 7099);
      const base = env.DROP_BASE_DOMAIN ?? "drop.example.com";
      return {
        tcpPortFrom: range.from,
        tcpPortTo: range.to,
        tcpLbHost: env.DROP_TCP_LB_HOST || base,
        tcpSharedPorts: parseSharedPorts(env.DROP_TCP_SHARED_PORTS ?? "5432:postgres"),
        edgeTcpNamespace: env.DROP_EDGE_TCP_NAMESPACE ?? "drop-system",
        edgeTcpService: env.DROP_EDGE_TCP_SERVICE ?? "drop-edge-tcp",
      };
    })(),
    previewSweepIntervalMs: Number(env.DROP_PREVIEW_SWEEP_INTERVAL_MS ?? String(5 * 60 * 1000)) || 5 * 60 * 1000,
    // db:proxy (A3): direct-dial is the in-cluster posture (the DB Service DNS is reachable from the pod);
    // locally the API is outside the cluster, so it defaults OFF and the tunnel returns 501 (documented).
    authEngineImage: env.DROP_AUTH_ENGINE_IMAGE || GOTRUE_IMAGE,
    authRateLimit: Number(env.DROP_AUTH_RATE_LIMIT ?? "10"),
    authRateWindowMs: Number(env.DROP_AUTH_RATE_WINDOW_MS ?? "60000") || 60000,
    tunnelDirect: env.DROP_TUNNEL_DIRECT === "1",
    tunnelTicketTtlMs: Number(env.DROP_TUNNEL_TICKET_TTL_MS ?? "60000") || 60000,
    tunnelIdleTimeoutMs: Number(env.DROP_TUNNEL_IDLE_TIMEOUT_MS ?? String(5 * 60 * 1000)) || 5 * 60 * 1000,
    maxTunnelsPerUser: Number(env.DROP_MAX_TUNNELS_PER_USER ?? "5") || 5,
    execIdleTimeoutMs: Number(env.DROP_EXEC_IDLE_TIMEOUT_MS ?? String(15 * 60 * 1000)) || 15 * 60 * 1000,
    maxExecPerUser: Number(env.DROP_MAX_EXEC_PER_USER ?? "3") || 3,
  };
}

// --- (J2) OIDC issuer helpers ---------------------------------------------------------------

/** True iff the issuer is Google. The `hd` (hosted-domain) claim is Google-specific, so the domain
 *  gate only trusts `hd` for Google — every other issuer falls back to the email-domain suffix. */
export function isGoogleIssuer(issuer: string): boolean {
  try {
    return new URL(issuer).hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

/** Best-effort human name for the provider, derived from the issuer host, used as the login-button
 *  label when DROP_OIDC_DISPLAY_NAME is unset. `https://accounts.google.com` → "Google",
 *  `https://dev-1.okta.com` → "Okta", `https://login.microsoftonline.com/...` → "Microsoftonline".
 *  Operators override it with DROP_OIDC_DISPLAY_NAME (e.g. "Entra ID"). */
export function deriveDisplayName(issuer: string): string {
  try {
    const host = new URL(issuer).hostname; // e.g. accounts.google.com
    let labels = host.split(".").filter(Boolean);
    const authSub = new Set(["accounts", "login", "auth", "sso", "id", "idp", "oauth", "signin", "www", "identity"]);
    if (labels.length > 2 && authSub.has(labels[0]!.toLowerCase())) labels = labels.slice(1);
    // Registrable label: the second-to-last for a normal domain (google.com → google), else the host.
    const label = labels.length >= 2 ? labels[labels.length - 2]! : labels[0] ?? host;
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "SSO";
  } catch {
    return "SSO";
  }
}

// --- edge-tcp (L4 router, A2a) ------------------------------------------------------------
// Kept as a SEPARATE loader (not folded into loadConfig) so the router entrypoint stays
// decoupled from the API's S3/DB requirements: A2a routes from a static JSON env; A2b swaps in
// the metastore source (which will bring its own DROP_DATABASE_URL). Same env-parsing style.

export interface TcpSharedPort {
  port: number;
  protocol: "tls-sni" | "postgres";
}

export interface TcpConfig {
  sharedPorts: TcpSharedPort[]; // well-known ports run the SNI / PG-preamble path
  dynamicPorts: number[]; // per-workload ports routed by port number alone
  idleTimeoutMs: number; // destroy both sockets after this long with no bytes either way
  maxConnsPerWorkload: number; // per-workload concurrent-connection cap
  handshakeTimeoutMs: number; // budget for the pre-splice peek/preamble/dial
  staticRoutesJson?: string; // DROP_TCP_STATIC_ROUTES — A2a route table (replaced by A2b metastore)
}

/** Parse `"5432:postgres,6379:tls-sni"` → shared port specs. Unknown protocols are dropped
 *  (with a warning) rather than crashing the router at boot. */
function parseSharedPorts(spec: string): TcpSharedPort[] {
  const out: TcpSharedPort[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [portStr, protoRaw] = part.split(":").map((s) => s.trim());
    const port = Number(portStr);
    const proto = (protoRaw ?? "").toLowerCase();
    const protocol = proto === "postgres" || proto === "pg" ? "postgres" : proto === "tls-sni" || proto === "sni" || proto === "tls" ? "tls-sni" : null;
    if (!port || !protocol) {
      console.warn(`DROP_TCP_SHARED_PORTS: ignoring invalid entry "${part}" (want PORT:postgres|tls-sni)`);
      continue;
    }
    out.push({ port, protocol });
  }
  return out;
}

/** Parse a dynamic-port range: `"7000-7099"` → [7000..7099], or a comma list `"7000,7005"`. */
function parseDynamicRange(spec: string): number[] {
  const s = spec.trim();
  if (!s) return [];
  if (s.includes(",")) return s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const m = /^(\d+)-(\d+)$/.exec(s);
  if (!m) {
    const one = Number(s);
    return Number.isInteger(one) && one > 0 ? [one] : [];
  }
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (to < from || to - from > 1024) {
    console.warn(`DROP_TCP_DYNAMIC_RANGE: ignoring range "${s}" (empty or wider than 1024 ports)`);
    return [];
  }
  const out: number[] = [];
  for (let p = from; p <= to; p++) out.push(p);
  return out;
}

/** Parse a `"7000-7099"` (or single `"7000"`) port range → `{from,to}`, clamped to a sane 1024-wide
 *  window; junk / inverted / oversized falls back to the provided defaults. Used for the A2b dynamic
 *  expose pool the API allocates ports from. */
export function parsePortRange(spec: string, defFrom: number, defTo: number): { from: number; to: number } {
  const s = (spec ?? "").trim();
  if (!s) return { from: defFrom, to: defTo };
  const m = /^(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) return { from: defFrom, to: defTo };
  const from = Number(m[1]);
  const to = m[2] !== undefined ? Number(m[2]) : from;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || to < from || to - from > 1024) {
    return { from: defFrom, to: defTo };
  }
  return { from, to };
}

export function loadTcpConfig(env: Record<string, string | undefined> = process.env): TcpConfig {
  return {
    sharedPorts: parseSharedPorts(env.DROP_TCP_SHARED_PORTS ?? "5432:postgres"),
    dynamicPorts: parseDynamicRange(env.DROP_TCP_DYNAMIC_RANGE ?? ""),
    idleTimeoutMs: Number(env.DROP_TCP_IDLE_TIMEOUT_MS ?? String(5 * 60 * 1000)) || 5 * 60 * 1000,
    maxConnsPerWorkload: Number(env.DROP_TCP_MAX_CONNS_PER_WORKLOAD ?? "100") || 100,
    handshakeTimeoutMs: Number(env.DROP_TCP_HANDSHAKE_TIMEOUT_MS ?? "10000") || 10000,
    staticRoutesJson: env.DROP_TCP_STATIC_ROUTES || undefined,
  };
}
