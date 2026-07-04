import type { Session } from "./session.ts";
import type { AppConfig } from "../app-config.ts";
import type { DatabaseConfig } from "../db-config.ts";
import type { CacheConfig } from "../cache-config.ts";
import type { StackSpec } from "../stack-config.ts";
import { createClient, type DropMethods } from "@drop/client";

export class Client {
  // (L5) Routes registered in the OpenAPI spec go through the GENERATED @drop/client, making the CLI its
  // first consumer + the permanent conformance surface. Un-registered routes stay on `req()` below and
  // migrate opportunistically. Both share the same Session (base URL + bearer token).
  private readonly gen: DropMethods;
  constructor(private s: Session) {
    this.gen = createClient({ baseUrl: s.apiBase, headers: () => ({ authorization: `Bearer ${s.token}` }) });
  }

  private async req(
    method: string,
    path: string,
    opts: { contentType?: string; body?: string | Uint8Array } = {},
  ): Promise<any> {
    const res = await fetch(this.s.apiBase + path, {
      method,
      headers: {
        authorization: `Bearer ${this.s.token}`,
        ...(opts.contentType ? { "content-type": opts.contentType } : {}),
      },
      body: opts.body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as any).error ?? `${path}: ${res.status}`);
    return json;
  }

  private orgQ(org?: string) {
    return org ? `?org=${encodeURIComponent(org)}` : "";
  }
  // (L5) migrated to @drop/client: POST /v1/sites/:name/versions
  publish(name: string, tarball: Buffer | Uint8Array, org?: string, preview?: { label: string; expireDays?: number }) {
    const query: { org?: string; preview?: string; expire_days?: string } = {};
    if (org) query.org = org;
    if (preview) {
      query.preview = preview.label;
      if (preview.expireDays != null) query.expire_days = String(preview.expireDays);
    }
    return this.gen.publishSiteVersion({ name }, tarball, query);
  }
  // previews (E1): `list` mirrors GET .../previews; `remove` is audited server-side (preview.delete)
  previewList(name: string) {
    return this.req("GET", `/v1/sites/${name}/previews`);
  }
  previewRemove(name: string, label: string) {
    return this.req("DELETE", `/v1/sites/${name}/previews/${encodeURIComponent(label)}`);
  }
  deploy(name: string, app: AppConfig, org?: string, noStart?: boolean, preview?: { label: string; withDb?: boolean; fromBackup?: boolean; at?: string; expireDays?: number }) {
    const q = new URLSearchParams();
    if (org) q.set("org", org);
    if (noStart) q.set("start", "false");
    // (E2) A preview deploys a parallel `<name>-p-<label>` workload at <name>--<label>; --with-db clones
    // an empty database; expire_days overrides the 7d default. The live app is untouched.
    // (L2) --from-backup branches the --with-db clone from the parent db's Barman backup (--at = PITR).
    if (preview) {
      q.set("preview", preview.label);
      if (preview.withDb) q.set("with_db", "true");
      if (preview.fromBackup) q.set("from_backup", "true");
      if (preview.at) q.set("at", preview.at);
      if (preview.expireDays != null) q.set("expire_days", String(preview.expireDays));
    }
    const qs = q.toString();
    return this.req("POST", `/v1/apps/${name}${qs ? `?${qs}` : ""}`, {
      contentType: "application/json",
      body: JSON.stringify(app),
    });
  }
  /** Stream a `docker save` image tarball to the API, which makes it pullable by the cluster.
   *  `body` is a Node Readable (the save stdout) so large images never buffer in memory. */
  async pushImage(name: string, body: NodeJS.ReadableStream | Uint8Array, tag: string, org?: string) {
    const q = new URLSearchParams({ tag });
    if (org) q.set("org", org);
    const res = await fetch(`${this.s.apiBase}/v1/apps/${name}/image?${q.toString()}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${this.s.token}`, "content-type": "application/octet-stream" },
      body: body as any,
      duplex: "half", // required by fetch when streaming a request body
    } as RequestInit);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as any).error ?? `image push: ${res.status}`);
    return json;
  }
  dbCreate(name: string, db: DatabaseConfig | Record<string, never>, org?: string) {
    return this.req("POST", `/v1/databases/${name}${this.orgQ(org)}`, {
      contentType: "application/json",
      body: JSON.stringify(db),
    });
  }
  // organisations
  createOrg(slug: string, name?: string) {
    return this.req("POST", `/v1/orgs`, { contentType: "application/json", body: JSON.stringify({ slug, name }) });
  }
  // (L5) migrated to @drop/client: GET /v1/orgs, /v1/orgs/:slug, /v1/orgs/:slug/usage
  listOrgs() {
    return this.gen.listOrgs();
  }
  orgInfo(slug: string) {
    return this.gen.getOrg({ slug });
  }
  orgUsage(slug: string) {
    return this.gen.getOrgUsage({ slug });
  }
  addOrgMember(slug: string, email: string, role?: string) {
    return this.req("POST", `/v1/orgs/${slug}/members`, { contentType: "application/json", body: JSON.stringify({ email, role }) });
  }
  removeOrgMember(slug: string, email: string) {
    return this.req("DELETE", `/v1/orgs/${slug}/members/${encodeURIComponent(email)}`);
  }
  // service accounts / scoped CI tokens (J1) — create returns the secret ONCE
  createToken(slug: string, name: string, scopes: string[], expiresDays?: number) {
    return this.req("POST", `/v1/orgs/${slug}/tokens`, {
      contentType: "application/json",
      body: JSON.stringify({ name, scopes, ...(expiresDays ? { expires_days: expiresDays } : {}) }),
    });
  }
  listTokens(slug: string) {
    return this.req("GET", `/v1/orgs/${slug}/tokens`);
  }
  revokeToken(slug: string, id: string) {
    return this.req("DELETE", `/v1/orgs/${slug}/tokens/${encodeURIComponent(id)}`);
  }
  // (G3) alerting / notifications — the org events feed + the outbound webhook config
  listEvents(slug: string, opts: { cursor?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.req("GET", `/v1/orgs/${slug}/events${qs ? `?${qs}` : ""}`);
  }
  getWebhook(slug: string) {
    return this.req("GET", `/v1/orgs/${slug}/webhook`);
  }
  setWebhook(slug: string, url: string, secret?: string) {
    return this.req("POST", `/v1/orgs/${slug}/webhook`, { contentType: "application/json", body: JSON.stringify({ url, ...(secret ? { secret } : {}) }) });
  }
  removeWebhook(slug: string) {
    return this.req("DELETE", `/v1/orgs/${slug}/webhook`);
  }
  dbPassword(name: string, password?: string, setSecret?: { app: string; key: string }, show?: boolean) {
    return this.req("POST", `/v1/databases/${name}/password`, {
      contentType: "application/json",
      body: JSON.stringify({ ...(password ? { password } : {}), ...(setSecret ? { setSecret } : {}), ...(show ? { show: true } : {}) }),
    });
  }
  // managed-database backups + hibernation
  dbBackups(name: string) {
    return this.req("GET", `/v1/databases/${name}/backups`);
  }
  dbBackup(name: string) {
    return this.req("POST", `/v1/databases/${name}/backups`);
  }
  dbHibernate(name: string) {
    return this.req("POST", `/v1/databases/${name}/hibernate`);
  }
  dbWake(name: string) {
    return this.req("POST", `/v1/databases/${name}/wake`);
  }
  // (I3) connection pooling: enable emits a CNPG Pooler; disable deletes it.
  dbPooler(name: string, enable: boolean, mode?: "transaction" | "session") {
    return this.req("POST", `/v1/databases/${name}/pooler`, { contentType: "application/json", body: JSON.stringify({ enable, ...(mode ? { mode } : {}) }) });
  }
  // (I3) extensions: create-time only — `ext add` on an existing db 409s honestly server-side.
  dbExtAdd(name: string, extensions: string[]) {
    return this.req("POST", `/v1/databases/${name}/extensions`, { contentType: "application/json", body: JSON.stringify({ add: extensions }) });
  }
  // (I4) SQL console: a READ-ONLY query (session-enforced read-only, 5s timeout, 500-row cap; audited).
  // Writes are refused at the engine — use `drop db proxy` + a real client for those.
  dbQuery(name: string, sql: string) {
    return this.req("POST", `/v1/databases/${name}/query`, { contentType: "application/json", body: JSON.stringify({ sql }) });
  }
  // (I2) managed cache (Valkey) — create returns REDIS_URL (password embedded) ONCE.
  cacheCreate(name: string, cache: CacheConfig | Record<string, never>, org?: string) {
    return this.req("POST", `/v1/caches/${name}${this.orgQ(org)}`, { contentType: "application/json", body: JSON.stringify(cache) });
  }
  cacheList(org?: string) {
    return this.req("GET", `/v1/caches${this.orgQ(org)}`);
  }
  // (K1) managed auth resource (GoTrue). create requires a same-org database (via `db`); the JWT secret
  // is never returned. `--with-db` sugar composes db-create + auth-create CLI-side (see commands.ts).
  authCreate(name: string, body: Record<string, unknown>, org?: string) {
    return this.req("POST", `/v1/auths/${name}${this.orgQ(org)}`, { contentType: "application/json", body: JSON.stringify(body) });
  }
  authList(org?: string) {
    return this.req("GET", `/v1/auths${this.orgQ(org)}`);
  }
  authConfig(name: string) {
    return this.req("GET", `/v1/sites/${name}`); // detail carries the auth config surface (never key material)
  }
  authRotateKeys(name: string) {
    return this.req("POST", `/v1/auths/${name}/rotate-keys`, { contentType: "application/json", body: "{}" });
  }
  authUsersList(name: string) {
    return this.req("GET", `/v1/auths/${name}/users`);
  }
  authUserCreate(name: string, email: string, password?: string) {
    return this.req("POST", `/v1/auths/${name}/users`, { contentType: "application/json", body: JSON.stringify({ email, ...(password ? { password } : {}) }) });
  }
  authUserRemove(name: string, id: string) {
    return this.req("DELETE", `/v1/auths/${name}/users/${encodeURIComponent(id)}`);
  }
  // tenant object storage (buckets, I1) — create/rotate return the access creds ONCE
  bucketCreate(name: string, org?: string) {
    return this.req("POST", `/v1/buckets/${name}${this.orgQ(org)}`, { contentType: "application/json", body: "{}" });
  }
  bucketList(org?: string) {
    return this.req("GET", `/v1/buckets${this.orgQ(org)}`);
  }
  bucketRotate(name: string) {
    return this.req("POST", `/v1/buckets/${name}/rotate`, { contentType: "application/json", body: "{}" });
  }
  bucketRemove(name: string, force?: boolean) {
    return this.req("DELETE", `/v1/sites/${name}${force ? "?force=1" : ""}`);
  }
  setSecret(app: string, key: string, value: string) {
    return this.req("PUT", `/v1/apps/${app}/secrets/${encodeURIComponent(key)}`, {
      contentType: "application/json",
      body: JSON.stringify({ value }),
    });
  }
  listSecrets(app: string) {
    return this.req("GET", `/v1/apps/${app}/secrets`);
  }
  deleteSecret(app: string, key: string) {
    return this.req("DELETE", `/v1/apps/${app}/secrets/${encodeURIComponent(key)}`);
  }
  // (L4) app runtime config — a NON-SECRET key/value store. `configSet` triggers the lazy per-app
  // read-token mint server-side; the CLI just calls PUT. `configList` returns `{config, version}`.
  configSet(app: string, key: string, value: string) {
    return this.req("PUT", `/v1/apps/${app}/config/${encodeURIComponent(key)}`, {
      contentType: "application/json",
      body: JSON.stringify({ value }),
    });
  }
  configList(app: string) {
    return this.req("GET", `/v1/apps/${app}/config`);
  }
  configRemove(app: string, key: string) {
    return this.req("DELETE", `/v1/apps/${app}/config/${encodeURIComponent(key)}`);
  }
  // (L3) `drop dev` context: the app's NON-secret env + DB/cache binding metadata + the NAMES of the
  // secret keys it expects (never values). The developer fills those names into .env.dev locally —
  // secrets are never pulled. Consumed by src/cli/dev.ts (tunnel orchestration + env materialization).
  devContext(app: string) {
    return this.req("GET", `/v1/apps/${app}/dev-context`);
  }
  restartApp(app: string) {
    return this.req("POST", `/v1/apps/${app}/restart`);
  }
  stopApp(app: string) {
    return this.req("POST", `/v1/apps/${app}/stop`);
  }
  startApp(app: string) {
    return this.req("POST", `/v1/apps/${app}/start`);
  }
  rollback(name: string, to: string) {
    return this.req("POST", `/v1/sites/${name}/rollback`, {
      contentType: "application/json",
      body: JSON.stringify({ to }),
    });
  }
  // (L5) migrated to @drop/client: GET /v1/sites/:name
  info(name: string) {
    return this.gen.getSite({ name });
  }
  /** (G2) Edge request metrics for a workload — `{range, series, totals}`. `range` is 1h|24h|7d. */
  metrics(name: string, range?: string) {
    return this.req("GET", `/v1/sites/${name}/metrics${range ? `?range=${encodeURIComponent(range)}` : ""}`);
  }
  // TCP (L4) exposure (A2b): opt-in, default off. mode 'sni' (shared port, no port consumed) or
  // 'port' (dedicated allocated port). Response carries the connect string.
  expose(name: string, opts: { mode: "sni" | "port"; protocol?: string }) {
    return this.req("POST", `/v1/sites/${name}/expose`, { contentType: "application/json", body: JSON.stringify(opts) });
  }
  unexpose(name: string) {
    return this.req("DELETE", `/v1/sites/${name}/expose`);
  }
  exposeList(org?: string) {
    return this.req("GET", `/v1/expose${this.orgQ(org)}`);
  }
  /** Per-process status for an app (drop ps): one row per web/worker Deployment. */
  processes(app: string) {
    return this.req("GET", `/v1/apps/${app}/processes`);
  }
  /** Recent workload logs. `release` reads the latest release Job's pod instead of the app pods. */
  logs(name: string, opts: { tail?: number; release?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.tail) q.set("tail", String(opts.tail));
    if (opts.release) q.set("release", "1");
    const qs = q.toString();
    return this.req("GET", `/v1/sites/${name}/logs${qs ? `?${qs}` : ""}`);
  }
  /** (G4) Search the retained log history: time-range narrows to indexed S3 objects, the text match runs
   *  server-side (grep-grade substring/regex). `from`/`to` are ISO/epoch; `q` is the pattern. */
  logsSearch(name: string, opts: { from?: string; to?: string; q?: string; limit?: number; regex?: boolean; ignoreCase?: boolean } = {}) {
    const p = new URLSearchParams();
    if (opts.from) p.set("from", opts.from);
    if (opts.to) p.set("to", opts.to);
    if (opts.q) p.set("q", opts.q);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.regex) p.set("regex", "1");
    if (opts.ignoreCase) p.set("i", "1");
    const qs = p.toString();
    return this.req("GET", `/v1/sites/${name}/logs/search${qs ? `?${qs}` : ""}`);
  }
  /** Stream logs live (G1, `drop logs -f`): the server keeps the connection open and writes new
   *  lines as they arrive. Returns the raw fetch Response — unlike `req()`, the body is
   *  `text/plain`, not JSON — so the caller can pump `.body` and abort it (e.g. on Ctrl-C). */
  async logsFollow(name: string, opts: { tail?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const q = new URLSearchParams({ follow: "1" });
    if (opts.tail) q.set("tail", String(opts.tail));
    const res = await fetch(`${this.s.apiBase}/v1/sites/${name}/logs?${q}`, {
      headers: { authorization: `Bearer ${this.s.token}` },
      signal: opts.signal,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error((json as any).error ?? `logs: ${res.status}`);
    }
    return res;
  }
  // (L5) migrated to @drop/client: GET /v1/sites
  list(org?: string) {
    return this.gen.listSites(org ? { org } : undefined);
  }
  // (I5) `force` confirms data loss: a stateful app's volume (or a non-empty bucket's contents, I1) —
  // same `?force=1` convention as `bucketRemove`.
  remove(name: string, force?: boolean) {
    return this.req("DELETE", `/v1/sites/${name}${force ? "?force=1" : ""}`);
  }
  share(name: string, email: string) {
    return this.req("POST", `/v1/sites/${name}/collaborators`, {
      contentType: "application/json",
      body: JSON.stringify({ email }),
    });
  }
  unshare(name: string, email: string) {
    return this.req("DELETE", `/v1/sites/${name}/collaborators/${encodeURIComponent(email)}`);
  }
  transfer(name: string, target: { email?: string; toOrg?: string }) {
    return this.req("POST", `/v1/sites/${name}/transfer`, {
      contentType: "application/json",
      body: JSON.stringify(target),
    });
  }
  // stacks (B2): declarative multi-resource up + list/status/delete. (E3) `env` targets an environment.
  stackUp(
    name: string,
    spec: StackSpec,
    opts: { org?: string; dryRun?: boolean; prune?: boolean; resolved?: Record<string, { image: string }>; specVersion?: number; env?: string } = {},
  ) {
    const q = new URLSearchParams();
    if (opts.org) q.set("org", opts.org);
    if (opts.dryRun) q.set("dry_run", "1");
    if (opts.env) q.set("env", opts.env);
    const qs = q.toString();
    return this.req("POST", `/v1/stacks/${name}/up${qs ? `?${qs}` : ""}`, {
      contentType: "application/json",
      body: JSON.stringify({ spec, ...(opts.resolved ? { resolved: opts.resolved } : {}), ...(opts.prune ? { prune: true } : {}), ...(opts.specVersion != null ? { spec_version: opts.specVersion } : {}) }),
    });
  }
  stackList(org?: string) {
    return this.req("GET", `/v1/stacks${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  }
  stackGet(name: string, opts: { org?: string; env?: string } = {}) {
    const q = new URLSearchParams();
    if (opts.org) q.set("org", opts.org);
    if (opts.env) q.set("env", opts.env);
    const qs = q.toString();
    return this.req("GET", `/v1/stacks/${name}${qs ? `?${qs}` : ""}`);
  }
  // environments (E3): named durable instantiations with a per-env variable overlay
  envList(name: string, org?: string) {
    return this.req("GET", `/v1/stacks/${encodeURIComponent(name)}/environments${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  }
  envCreate(name: string, env: string, variables: Record<string, string>, org?: string) {
    return this.req("POST", `/v1/stacks/${encodeURIComponent(name)}/environments${org ? `?org=${encodeURIComponent(org)}` : ""}`, {
      contentType: "application/json",
      body: JSON.stringify({ env, variables }),
    });
  }
  envDelete(name: string, env: string, opts: { org?: string; cascade?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.org) q.set("org", opts.org);
    if (opts.cascade) q.set("cascade", "1");
    const qs = q.toString();
    return this.req("DELETE", `/v1/stacks/${encodeURIComponent(name)}/environments/${encodeURIComponent(env)}${qs ? `?${qs}` : ""}`);
  }
  envPromote(name: string, source: string, to: string, org?: string) {
    return this.req("POST", `/v1/stacks/${encodeURIComponent(name)}/environments/${encodeURIComponent(source)}/promote${org ? `?org=${encodeURIComponent(org)}` : ""}`, {
      contentType: "application/json",
      body: JSON.stringify({ to }),
    });
  }
  stackDelete(name: string, opts: { org?: string; cascade?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.org) q.set("org", opts.org);
    if (opts.cascade) q.set("cascade", "1");
    const qs = q.toString();
    return this.req("DELETE", `/v1/stacks/${name}${qs ? `?${qs}` : ""}`);
  }
  // (B3) GitOps link — pull-only git→stack sync. The token is WRITE-ONLY: sent once at link time,
  // stored server-side for the poller's auth header, and masked to `hasToken` in every response.
  stackLink(name: string, payload: { repo: string; branch?: string; path?: string; token?: string; dryRunOnly?: boolean }, org?: string) {
    return this.req("POST", `/v1/stacks/${encodeURIComponent(name)}/link${this.orgQ(org)}`, { contentType: "application/json", body: JSON.stringify(payload) });
  }
  stackLinkStatus(name: string, org?: string) {
    return this.req("GET", `/v1/stacks/${encodeURIComponent(name)}/link${this.orgQ(org)}`);
  }
  stackUnlink(name: string, org?: string) {
    return this.req("DELETE", `/v1/stacks/${encodeURIComponent(name)}/link${this.orgQ(org)}`);
  }
  stackLinkSync(name: string, org?: string) {
    return this.req("POST", `/v1/stacks/${encodeURIComponent(name)}/link/sync${this.orgQ(org)}`, { contentType: "application/json", body: "{}" });
  }
  stackLinkApply(name: string, org?: string) {
    return this.req("POST", `/v1/stacks/${encodeURIComponent(name)}/link/apply${this.orgQ(org)}`, { contentType: "application/json", body: "{}" });
  }
  // template upstream diff (D2): outdated (three-way diff) + upgrade (merge → standard reconcile)
  stackOutdated(name: string, org?: string) {
    return this.req("GET", `/v1/stacks/${encodeURIComponent(name)}/outdated${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  }
  stackUpgrade(
    name: string,
    payload: { to?: string; resolutions?: Record<string, "take-upstream" | "keep-local"> },
    opts: { org?: string; dryRun?: boolean; prune?: boolean } = {},
  ) {
    const q = new URLSearchParams();
    if (opts.org) q.set("org", opts.org);
    if (opts.dryRun) q.set("dry_run", "1");
    if (opts.prune) q.set("prune", "1");
    const qs = q.toString();
    return this.req("POST", `/v1/stacks/${encodeURIComponent(name)}/upgrade${qs ? `?${qs}` : ""}`, { contentType: "application/json", body: JSON.stringify(payload) });
  }
  // templates (D1): publish / list / get / instantiate
  templatePublish(payload: {
    slug: string;
    name?: string;
    description?: string;
    visibility?: "public" | "org";
    spec?: StackSpec;
    from_stack?: string;
    variables?: { key: string; description?: string; default?: string; required: boolean; secret?: boolean }[];
    readme?: string;
    allow?: string[];
    org?: string;
  }) {
    const { org, ...rest } = payload;
    return this.req("POST", `/v1/templates${this.orgQ(org)}`, { contentType: "application/json", body: JSON.stringify(rest) });
  }
  templateList() {
    return this.req("GET", `/v1/templates`);
  }
  templateGet(slug: string, version?: string) {
    return this.req("GET", `/v1/templates/${encodeURIComponent(slug)}${version ? `?version=${encodeURIComponent(version)}` : ""}`);
  }
  templateInstantiate(slug: string, payload: { name: string; org?: string; vars?: Record<string, string>; version?: string }, dryRun?: boolean) {
    return this.req("POST", `/v1/templates/${encodeURIComponent(slug)}/instantiate${dryRun ? "?dry_run=1" : ""}`, {
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  }
  // platform admin: users + roles + status
  adminListUsers() {
    return this.req("GET", `/v1/admin/users`);
  }
  adminSetRole(email: string, role: string) {
    return this.req("POST", `/v1/admin/users/${encodeURIComponent(email)}/role`, { contentType: "application/json", body: JSON.stringify({ role }) });
  }
  adminSetStatus(email: string, status: string) {
    return this.req("POST", `/v1/admin/users/${encodeURIComponent(email)}/status`, { contentType: "application/json", body: JSON.stringify({ status }) });
  }
  adminAudit(opts: { actor?: string; target?: string; action?: string; limit?: number; cursor?: string } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v != null && v !== "") q.set(k, String(v));
    const qs = q.toString();
    return this.req("GET", `/v1/admin/audit${qs ? `?${qs}` : ""}`);
  }
}
