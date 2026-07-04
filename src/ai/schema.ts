// (F2) The stack JSON schema handed to the LLM as its STRUCTURED-OUTPUT CONTRACT. Hand-written and
// deliberately compact — it does NOT need to be exhaustive, because the model's raw output is ALWAYS
// re-validated by `sanitizeStackConfig` (src/stack-config.ts) server-side: junk is dropped, unknown
// fields are ignored, unknown resource types are skipped. The schema's only job is to STEER the model
// toward the shape Drop accepts.
//
// IT MUST TRACK stack-config: the accepted top-level resource fields listed in `STACK_RESOURCE_FIELDS`
// mirror what `sanitizeStackConfig` keeps. `schema.test.ts` locks the two together (it sanitizes a maximal
// spec and asserts every surviving key is advertised here), so a new accepted field landing server-side
// breaks the test rather than silently drifting out of the prompt.

/** The resource `type` discriminator values `sanitizeStackConfig` accepts (mirrors StackResourceKind). */
export const STACK_RESOURCE_KINDS = ["site", "app", "database", "bucket", "cache", "auth"] as const;

/** The per-resource fields the schema advertises. Mirrors the fields `sanitizeStackConfig` keeps on a
 *  StackResource across all types (the sanitizer is the ground truth; schema.test.ts locks these). */
export const STACK_RESOURCE_FIELDS = [
  "type",
  "name",
  "dir",
  "env",
  // app
  "image",
  "services",
  "resources",
  "scale",
  "trusted",
  "uses",
  "healthcheck",
  "release",
  "processes",
  "expose",
  // site
  "env_from",
  // database
  "storage",
  "hibernation",
  // cache
  "memory",
  "persistent",
  // auth
  "db",
  "providers",
  "redirect_urls",
  "jwt_ttl",
  "signup",
  "site_url",
  "rbac",
] as const;

// A single resource. `additionalProperties: true` is deliberate — a type carries type-specific fields
// (services, healthcheck, providers, …) and the sanitizer discards anything it doesn't recognise, so we
// don't need to enumerate every one here. Edges reference resource KEYS within the same stack:
//   app.uses:     [{ database|bucket|cache|auth|app: "<key>" }]   (app→provider / app→app)
//   site.env_from:[{ resource: "<app key>", output: "url", as: "ENV_NAME" }] (site→app, publish-time)
//   auth.db:      "<database key>"                                (auth→database, REQUIRED on an auth)
const RESOURCE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["type"],
  properties: {
    type: { type: "string", enum: [...STACK_RESOURCE_KINDS] },
    name: { type: "string", description: "optional explicit site-name override; else <stack>-<key>" },
    dir: { type: "string", description: "CLI-side build/publish context (informational); no bytes are sent server-side" },
    env: { type: "object", additionalProperties: { type: "string" }, description: "plain, NON-SECRET env vars only — never put passwords/tokens here" },
    image: { type: "string", description: "app: a PUBLIC image ref (e.g. ghcr.io/org/app:tag), or omit to build+push via the CLI" },
    services: { type: "array", items: { type: "object", properties: { internalPort: { type: "integer" }, protocol: { type: "string", enum: ["http", "tcp"] } } } },
    resources: { type: "object", properties: { cpu: { type: "string" }, memory: { type: "string" } } },
    scale: { type: "object", properties: { min: { type: "integer" }, max: { type: "integer" } } },
    uses: {
      type: "array",
      description: "app edges to providers/peers, each a single-key object referencing a resource KEY",
      items: { type: "object", properties: { database: { type: "string" }, bucket: { type: "string" }, cache: { type: "string" }, auth: { type: "string" }, app: { type: "string" } } },
    },
    env_from: {
      type: "array",
      description: "site→app edges: substitute the app's URL into the site at publish time",
      items: { type: "object", required: ["resource", "output", "as"], properties: { resource: { type: "string" }, output: { type: "string", enum: ["url"] }, as: { type: "string" } } },
    },
    storage: { type: "string", description: "database PVC size, a k8s quantity like 512Mi or 1Gi" },
    memory: { type: "string", description: "cache memory, a k8s quantity like 256Mi" },
    persistent: { type: "boolean", description: "cache: persist to disk" },
    db: { type: "string", description: "auth: the database resource KEY its users live in (REQUIRED on an auth resource)" },
  },
} as const;

/** The full stack schema: a name (short DNS label) + a map of ≤16 resources keyed by short DNS labels. */
export const STACK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "resources"],
  properties: {
    name: { type: "string", description: "the stack name — a short lowercase DNS label (a-z, 0-9, -)" },
    resources: {
      type: "object",
      description: "1–16 resources keyed by short lowercase DNS labels (e.g. db, api, web)",
      additionalProperties: RESOURCE_SCHEMA,
    },
    notes: { type: "string", description: "OPTIONAL: a one-line note to the human about assumptions you made" },
  },
} as const;
