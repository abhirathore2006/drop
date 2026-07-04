// L5 — the registered routes + their zod response schemas.
//
// These schemas MIRROR the existing hand-routed responses in src/api/server.ts (they document, they do
// not define). conformance.test.ts validates each live response against the matching schema, so any
// drift here fails CI rather than shipping a lying spec. Registering a route is opportunistic — this is a
// representative subset of the stable, public surface, NOT every route.

import { z } from "zod";
import { Registry } from "./registry.ts";
import { ACTIONS } from "../../authz/permissions.ts";

// ---- shared enums (single source: the same string unions the DB schema / permissions use) ----
const zWorkloadType = z.enum(["site", "app", "database", "bucket", "cache", "auth"]);
const zVisibility = z.enum(["public", "private", "password"]);
const zOrgKind = z.enum(["personal", "team"]);
const zOrgRole = z.enum(["owner", "admin", "member", "viewer"]);
const zSiteRole = z.enum(["owner", "editor", "viewer"]);
const zAction = z.enum(ACTIONS); // the permission verbs `capabilitiesFor` can surface

// ---- shared object fragments ----
const zOrgRef = z.object({ slug: z.string(), name: z.string(), kind: zOrgKind });

const zVersionMeta = z.object({
  id: z.string(),
  publishedBy: z.string(),
  createdAt: z.string(),
  fileCount: z.number(),
  bytes: z.number(),
  // the parsed drop.yaml / app / db / cache / auth config — shape varies by type, documented loosely
  config: z.record(z.string(), z.unknown()).optional(),
});

const zUptime = z.object({
  last24hPct: z.number().nullable(),
  lastCheck: z
    .object({ ok: z.boolean(), latencyMs: z.number(), status: z.number(), at: z.string() })
    .nullable(),
});

// The M0 normalised status contract: one server-side mapping of the raw signals to the console/CLI enum.
const zStatus = z.object({
  status: z.enum(["running", "asleep", "progressing", "degraded", "stopped", "error"]),
  reason: z.string(),
});

const zPreview = z.object({
  label: z.string(),
  versionId: z.string(),
  url: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  kind: z.string(),
  hasDb: z.boolean(),
  branchedFrom: z.string().optional(),
  branchedAt: z.string().optional(),
});

const zSiteListItem = z.object({
  name: z.string(),
  type: zWorkloadType,
  owner: z.string(),
  visibility: zVisibility,
  url: z.string(),
  current: z.string().nullable(),
  org: zOrgRef.nullable(),
  capabilities: z.array(zAction),
});

// ---- response schemas ----
const GetVersionResponse = z.object({ version: z.string() });

const GetMeResponse = z.object({
  email: z.string(),
  admin: z.boolean(),
  unresolvedEvents: z.number(),
});

const GetFeaturesResponse = z.object({ llmEnabled: z.boolean() });

const ListOrgsResponse = z.object({
  orgs: z.array(z.object({ slug: z.string(), name: z.string(), kind: zOrgKind, role: zOrgRole })),
});

const GetOrgResponse = z.object({
  slug: z.string(),
  name: z.string(),
  kind: zOrgKind,
  members: z.array(z.object({ email: z.string(), role: zOrgRole })),
});

const GetOrgUsageResponse = z.object({
  org: zOrgRef,
  workloads: z.object({
    site: z.number(),
    app: z.number(),
    database: z.number(),
    bucket: z.number(),
    cache: z.number(),
    auth: z.number(),
    total: z.number(),
  }),
  cap: z.number(), // 0 = unlimited
  quota: z
    .object({ hard: z.record(z.string(), z.string()), used: z.record(z.string(), z.string()) })
    .nullable(),
  storage: z.object({
    databases: z.object({ count: z.number(), requestedBytes: z.number() }),
    buckets: z.object({ count: z.number(), bytes: z.number() }),
    caches: z.object({ count: z.number(), bytes: z.number() }),
    budget: z.number().nullable(),
  }),
});

const ListSitesResponse = z.object({ sites: z.array(zSiteListItem) });

// The detail read. Top-level fields are always present; the per-type detail blocks + tcp/previews/uptime
// are best-effort (a cluster/metrics read failure omits them), so they're optional. `status` (the M0
// normalised enum) is always set.
const GetSiteResponse = z.object({
  name: z.string(),
  type: zWorkloadType,
  owner: z.string(),
  org: zOrgRef.nullable(),
  collaborators: z.array(z.string()),
  members: z.array(z.object({ email: z.string(), role: zSiteRole })),
  visibility: zVisibility,
  current: z.string().nullable(),
  url: z.string(),
  versions: z.array(zVersionMeta),
  capabilities: z.array(zAction),
  status: zStatus,
  // per-type detail — documented loosely (present only for the matching workload type)
  app: z.record(z.string(), z.unknown()).optional(),
  database: z.record(z.string(), z.unknown()).optional(),
  cache: z.record(z.string(), z.unknown()).optional(),
  auth: z.record(z.string(), z.unknown()).optional(),
  bucket: z.record(z.string(), z.unknown()).optional(),
  tcp: z.record(z.string(), z.unknown()).optional(),
  previews: z.array(zPreview).optional(),
  uptime: zUptime.optional(),
});

const PublishSiteVersionResponse = z.object({
  url: z.string(),
  version: z.string(),
  files: z.number(),
  bytes: z.number(),
  // present only for a preview publish (?preview=<label>); current_version is left untouched
  preview: z
    .object({ label: z.string(), url: z.string(), versionId: z.string(), expiresAt: z.string() })
    .optional(),
});

// ---- the registry ----
export const apiRegistry = new Registry();

apiRegistry.register({
  method: "GET",
  path: "/version",
  operationId: "getVersion",
  summary: "The CLI/API build version this instance serves (public).",
  tags: ["meta"],
  response: GetVersionResponse,
});

apiRegistry.register({
  method: "GET",
  path: "/v1/me",
  operationId: "getMe",
  summary: "The authenticated caller: email, platform-admin flag, and unresolved-event badge count.",
  tags: ["identity"],
  response: GetMeResponse,
});

apiRegistry.register({
  method: "GET",
  path: "/v1/features",
  operationId: "getFeatures",
  summary: "Which optional features this deployment has enabled.",
  tags: ["meta"],
  response: GetFeaturesResponse,
});

apiRegistry.register({
  method: "GET",
  path: "/v1/orgs",
  operationId: "listOrgs",
  summary: "The organisations the caller belongs to, with their role in each.",
  tags: ["orgs"],
  response: ListOrgsResponse,
});

apiRegistry.register({
  method: "GET",
  path: "/v1/orgs/:slug",
  operationId: "getOrg",
  summary: "An organisation's metadata + members.",
  tags: ["orgs"],
  response: GetOrgResponse,
});

apiRegistry.register({
  method: "GET",
  path: "/v1/orgs/:slug/usage",
  operationId: "getOrgUsage",
  summary: "An org's workload counts, workload cap, live cluster quota, and storage usage.",
  tags: ["orgs"],
  response: GetOrgUsageResponse,
});

apiRegistry.register({
  method: "GET",
  path: "/v1/sites",
  operationId: "listSites",
  summary: "The resources the caller can see, each with the caller's resolved capability set.",
  tags: ["sites"],
  query: [{ name: "org", description: "Filter to one org by slug (caller must be a member)." }],
  response: ListSitesResponse,
});

apiRegistry.register({
  method: "GET",
  path: "/v1/sites/:name",
  operationId: "getSite",
  summary: "A single resource's metadata, versions, capabilities, best-effort live detail, and status.",
  tags: ["sites"],
  response: GetSiteResponse,
});

apiRegistry.register({
  method: "POST",
  path: "/v1/sites/:name/versions",
  operationId: "publishSiteVersion",
  summary: "Publish a new static-site version from a gzipped tarball; flips the live pointer (or a preview).",
  tags: ["sites"],
  query: [
    { name: "org", description: "Owning org slug when first claiming the name." },
    { name: "preview", description: "Publish as a named preview instead of flipping current_version." },
    { name: "expire_days", description: "Preview lifetime in days (default 7)." },
  ],
  requestBody: { contentType: "application/gzip", binary: true, description: "A gzipped tarball of the site's files." },
  response: PublishSiteVersionResponse,
});
