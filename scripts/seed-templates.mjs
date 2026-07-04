// Seed the D1 template registry with the two example apps — proving the publish → `drop new` loop and
// starting the golden-path catalog. Idempotent: a slug that already exists is left as-is (republishing
// only appends a version, so re-running never piles up duplicates).
//
// Usage (local dev, DROP_DEV_AUTH=1 on the API):
//     make seed-templates                       # uses http://localhost:8473 + a dev token
//     DROP_API=http://localhost:8473 node scripts/seed-templates.mjs
//     DROP_TOKEN=drop_st_… node scripts/seed-templates.mjs   # or a real service token in CI
//
// The published specs mirror each example's `stack:` section but are IMAGE-PINNED (the locally-imported
// `:1` tags) so `drop new <slug>` is instantiable without the original source, and each adds a couple of
// variables to exercise the machinery: a non-secret `db_storage` and a SECRET `session_secret` wired to
// the app's SESSION_SECRET env (lifted to the write-only secret path at instantiate — never in the spec).

const API = (process.env.DROP_API ?? "http://localhost:8473").replace(/\/$/, "");
const EMAIL = process.env.DROP_SEED_EMAIL ?? "alice@example.com";
// A `drop_st_…` service token wins (CI); else a local dev token (`sub:email`, accepted when DROP_DEV_AUTH=1).
const TOKEN = process.env.DROP_TOKEN ?? `${EMAIL}:${EMAIL}`;

const auth = { authorization: `Bearer ${TOKEN}` };

/** One shared README used (lightly specialized) by both seed templates. `withAuth` adds the K2 auth bits. */
const readme = (name, image, withAuth) =>
  `# ${name}

A golden-path ${name} template: a container app + a managed Postgres database${withAuth ? " + a managed auth resource (per-app end users)" : ""}, wired together.

## What it creates
- a **database** (\`db\`) — managed Postgres with a 1Gi volume by default
${withAuth ? "- an **auth resource** (`auth`) — a per-app GoTrue engine + end-user pool in that database, with app-RBAC (`rbac: true`)\n" : ""}- an **app** (\`web\`) — the \`${image}\` image, bound to the database${withAuth ? " and the auth resource" : ""} via \`uses\`

## Variables
- \`db_storage\` — the database volume size (default \`1Gi\`)
- \`session_secret\` — a write-only app secret (never stored in the template or the stack spec)

## Deploy it
Run \`drop new ${name}\` (or use "Deploy this stack" on this page). After the up, the app's
database password is set with \`drop db password ${name}-db --set-secret ${name}-web:PGPASSWORD\`.${
    withAuth
      ? `\n\n## Seed app roles/permissions (once)
This template turns on \`auth.rbac: true\`, which wires the GoTrue JWT claims hook. Apply the RBAC schema
once against the bound database (the API has no tenant-DB SQL path in v1):
\`\`\`
drop db proxy ${name}-db                                   # prints a local port
drop auth rbac-seed ${name}-auth | psql "postgres://app@127.0.0.1:<port>/app"
\`\`\`
Then verify tokens in your app with \`@drop/auth\`'s \`verifyRequest(req)\` — it returns \`{ user, roles, permissions }\`.`
      : ""
  }`;

/** Build a template publish payload for an example (image-pinned; adds the two demo variables). `withAuth`
 *  makes it the "Next.js + Postgres + Auth" golden path — an extra managed auth resource with app-RBAC. */
function templateFor({ slug, name, image, cpu, memory, withAuth = false }) {
  const web = {
    type: "app",
    image,
    uses: withAuth ? [{ database: "db" }, { auth: "auth" }] : [{ database: "db" }],
    scale: { min: 1, max: 2 },
    resources: { cpu, memory },
    env: {
      PGHOST: "${stack}-db-rw",
      PGPORT: "5432",
      PGUSER: "app",
      PGDATABASE: "app",
      SESSION_SECRET: "${var.session_secret}",
    },
  };
  const resources = {
    db: { type: "database", storage: "${var.db_storage}" },
    // (K2) a per-app managed auth resource, living in the same `db`, with the app-RBAC claims hook wired.
    ...(withAuth ? { auth: { type: "auth", db: "db", rbac: true, signup: "open" } } : {}),
    web,
  };
  return {
    slug,
    name,
    description: withAuth
      ? `${name}: Next.js + Postgres + Auth (per-app users, app-RBAC claims hook), wired together`
      : `${name}: a container app + managed Postgres, wired together`,
    visibility: "public",
    variables: [
      { key: "db_storage", description: "database volume size", default: "1Gi", required: false },
      { key: "session_secret", description: "app session secret (write-only)", required: true, secret: true },
    ],
    readme: readme(name, image, withAuth),
    spec: { name: slug, resources },
  };
}

const SEEDS = [
  templateFor({ slug: "guestbook", name: "guestbook", image: "guestbook-node:1", cpu: "250m", memory: "256Mi" }),
  // The notes template is the "Next.js + Postgres + Auth" golden path (K2): app + db + a managed auth
  // resource with rbac: true (seed the roles/permissions tables with `drop auth rbac-seed`).
  templateFor({ slug: "notes", name: "notes", image: "notes-next:1", cpu: "500m", memory: "512Mi", withAuth: true }),
];

async function alreadyExists(slug) {
  const r = await fetch(`${API}/v1/templates/${encodeURIComponent(slug)}`, { headers: auth });
  return r.status === 200;
}

async function publish(payload) {
  const r = await fetch(`${API}/v1/templates`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `${r.status}`);
  return body;
}

async function main() {
  // Fail fast with a clear message if the API isn't reachable / auth isn't set up.
  const health = await fetch(`${API}/healthz`).catch(() => null);
  if (!health || !health.ok) throw new Error(`API not reachable at ${API} — start it (make start) or set DROP_API`);

  for (const seed of SEEDS) {
    if (await alreadyExists(seed.slug)) {
      console.log(`  · ${seed.slug} already published — skipping`);
      continue;
    }
    const res = await publish(seed);
    console.log(`  ✓ published ${res.slug} v${res.version} (${res.visibility}, ${res.resources} resources)`);
  }
  console.log(`  done — try:  drop new guestbook   /   open ${API}/templates`);
}

main().catch((e) => {
  console.error(`✗ seed-templates failed: ${e.message}`);
  process.exit(1);
});
