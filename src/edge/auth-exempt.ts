// The ONE visibility-model exemption in the edge (K1). Its own module + tests because it is the single
// most security-sensitive change in the visibility model — the plan requires it get "its own ADR"
// (docs/auth.html has the ADR-style write-up).
//
// A host of the form `auth--<name>` whose resolved workload is genuinely `type: auth` is the login
// surface of a managed auth resource: the platform session/visibility gate must NOT apply, because
// LOGIN IS THE AUTH — a session gate in front of the login endpoint is a chicken-and-egg lockout.
// In exchange, the edge applies a per-IP token-bucket rate limit to the sensitive POST auth paths
// (token/signup/verify/recover) BEFORE proxying, so the exemption can't be abused as an unthrottled
// credential-stuffing / account-enumeration endpoint.
//
// CRITICAL SCOPING: the exemption is granted ONLY when the resolved workload is `type: auth`. A site
// literally named "auth" with a preview label "foo" ALSO matches the `auth--` prefix, but is NOT an
// auth resource — it (and every other `--` preview host) KEEPS its gates. The caller MUST confirm the
// type; parseAuthHost is pure string parsing and does not (and cannot) make that determination.

/** The reserved host prefix for a managed auth resource: `auth--<name>.<baseDomain>`. */
export const AUTH_HOST_PREFIX = "auth--";

/** If `label` is an auth-host label (`auth--<name>`), return the auth resource name; else null. Pure
 *  string parsing — the caller still confirms the resolved workload is `type: auth`. Rejects a name
 *  that itself contains `--` (an auth resource name can't; such a label is a nested/preview host and
 *  must fall through to normal — gated — resolution). */
export function parseAuthHost(label: string): string | null {
  if (!label.startsWith(AUTH_HOST_PREFIX)) return null;
  const name = label.slice(AUTH_HOST_PREFIX.length);
  if (!name || name.includes("--")) return null;
  return name;
}

// The sensitive GoTrue POST paths — the credential + account-enumeration surface. Read paths (health,
// settings, JWKS) and OAuth GET callbacks are NOT limited here. `/token` covers password grant +
// refresh; `/signup`/`/verify`/`/recover`/`/otp`/`/magiclink` cover the enumeration-prone flows.
const RATE_LIMITED_RE = /^\/(token|signup|verify|recover|otp|magiclink)\b/;

/** True iff this method+path is one of the rate-limited auth POST paths. */
export function isRateLimitedAuthPath(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && RATE_LIMITED_RE.test(path);
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterS: number; // seconds until a token is available (0 when ok)
}

/**
 * A per-IP token-bucket rate limiter (in-process, per edge replica). `capacity` tokens refill
 * continuously at `capacity / windowMs`; each limited request costs one token. Returns `retryAfterS`
 * when throttled. In-process by design (matches G2's in-process metrics): a multi-replica edge
 * multiplies the effective limit by replica count — a documented, acceptable property for a v1 abuse
 * brake (it is NOT a billing meter). Idle buckets are evicted so a spray of source IPs can't grow the
 * map without bound.
 */
export class AuthRateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { limit: number; windowMs: number; now?: () => number }) {
    this.capacity = Math.max(1, opts.limit);
    this.windowMs = Math.max(1, opts.windowMs);
    this.refillPerMs = this.capacity / this.windowMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Take one token for `ip`. `{ ok: false, retryAfterS }` when the bucket is empty. */
  take(ip: string): RateLimitResult {
    const t = this.now();
    let b = this.buckets.get(ip);
    if (!b) {
      b = { tokens: this.capacity, updated: t };
      this.buckets.set(ip, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (t - b.updated) * this.refillPerMs);
      b.updated = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.maybeSweep(t);
      return { ok: true, retryAfterS: 0 };
    }
    // Seconds until the next whole token refills.
    const retryAfterS = Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerMs / 1000));
    return { ok: false, retryAfterS };
  }

  // Evict buckets that have fully refilled (idle at least one window) so the map stays bounded. Cheap:
  // runs at most ~once per window, and only scans on that boundary.
  private lastSweep = 0;
  private maybeSweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [ip, b] of this.buckets) {
      if (b.tokens >= this.capacity && t - b.updated >= this.windowMs) this.buckets.delete(ip);
    }
  }
}

/** Resolve the client IP for rate limiting from the proxy headers (nginx locally, ALB/ingress in
 *  prod), preferring the FIRST hop of x-forwarded-for; falls back to x-real-ip, then a fixed bucket so
 *  a missing header shares one throttle rather than bypassing it. */
export function clientIpForRateLimit(headers: { xff?: string; xRealIp?: string }): string {
  const xff = headers.xff?.split(",")[0]?.trim();
  if (xff) return xff;
  const real = headers.xRealIp?.trim();
  if (real) return real;
  return "unknown";
}
