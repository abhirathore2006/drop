export interface Config {
  httpPort: number;
  baseDomain: string;
  s3Bucket: string;
  s3Endpoint?: string; // set for Floci / MinIO; omit for real AWS
  s3Region: string;
  s3KeyId?: string;
  s3Secret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  allowedDomains: string[]; // empty = any Google account
  publicUrl: string; // externally-reachable API base, for the OAuth callback
  sessionSecret: string; // HS256 key for Drop session tokens (required unless devAuth)
  devAuth: boolean;
  maxUploadBytes: number;
  maxFiles: number;
  keepVersions: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const s3Bucket = env.DROP_S3_BUCKET ?? "";
  if (!s3Bucket) throw new Error("DROP_S3_BUCKET is required");
  return {
    httpPort: Number(env.DROP_HTTP_PORT ?? "8080"),
    baseDomain: env.DROP_BASE_DOMAIN ?? "drop.company.com",
    s3Bucket,
    s3Endpoint: env.DROP_S3_ENDPOINT || undefined,
    s3Region: env.DROP_S3_REGION ?? "us-east-1",
    s3KeyId: env.DROP_S3_KEY_ID || undefined,
    s3Secret: env.DROP_S3_SECRET || undefined,
    googleClientId: env.DROP_GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.DROP_GOOGLE_CLIENT_SECRET || undefined,
    allowedDomains: (env.DROP_ALLOWED_DOMAINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    publicUrl: (env.DROP_PUBLIC_URL ?? `http://localhost:${env.DROP_HTTP_PORT ?? "8080"}`).replace(/\/$/, ""),
    sessionSecret: env.DROP_SESSION_SECRET ?? "",
    devAuth: env.DROP_DEV_AUTH === "1",
    maxUploadBytes: Number(env.DROP_MAX_UPLOAD_BYTES ?? String(100 * 1024 * 1024)),
    maxFiles: Number(env.DROP_MAX_FILES ?? "5000"),
    keepVersions: Number(env.DROP_KEEP_VERSIONS ?? "10"),
  };
}
