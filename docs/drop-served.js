/* Served-by-app signal — intentionally a no-op as shipped.
 *
 * When a running Drop API serves these docs, it OVERRIDES this file at
 * /docs/drop-served.js with a one-liner that sets window.__DROP_API_ORIGIN__ to
 * its own origin. assets/site.js then rewrites the documented placeholder API
 * URL (https://api.drop.example.com) to that real origin, so the install
 * one-liner, DROP_API, and MCP config point at the live instance.
 *
 * On static hosts (GitHub Pages — including custom domains — Netlify, file://,
 * …) this no-op runs instead and leaves the global unset, so the documented
 * placeholder URLs stay exactly as written. The rewrite is therefore opt-in:
 * it happens only when the serving app explicitly announces its origin, never
 * inferred from the hostname. */
