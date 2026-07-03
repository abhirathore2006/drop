export interface Config {
  httpPort: number;
  baseDomain: string;
  s3Bucket: string;
  s3Endpoint?: string; // set for Floci / MinIO; omit for real AWS
  s3Region: string;
  s3KeyId?: string;
  s3Secret?: string;
  databaseUrl: string; // postgres connection string (required)
  googleClientId?: string;
  googleClientSecret?: string;
  allowedDomains: string[]; // empty = any Google account
  allowedEmails: string[]; // empty = no per-email restriction; else only these (lowercased)
  admins: string[]; // emails that can see/manage all sites (lowercased)
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
  edgeDiskCacheDir?: string; // edge: where to cache asset bytes on disk (off if unset)
  edgeDiskCacheBytes: number; // edge: disk cache budget
  interceptorUrl?: string; // edge: KEDA HTTP interceptor base URL — type=app hostnames proxy here (off if unset)
  wsMaxPerHost: number; // edge: per-host concurrent WebSocket-upgrade cap (0 falls back to the default)
  wsIdleTimeoutMs: number; // edge: WS idle timeout — destroy both sockets after this long with no bytes
  wsDirect: boolean; // edge: DROP_WS_DIRECT — bypass the interceptor, dial the app Service directly (wake shim)
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
    dbBackupRoleArn: env.DROP_DB_BACKUP_ROLE_ARN || undefined,
    dbBackupEndpoint: env.DROP_DB_BACKUP_S3_ENDPOINT || undefined,
    dbBackupEgressCidr: env.DROP_DB_BACKUP_S3_EGRESS_CIDR || undefined,
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
  };
}
