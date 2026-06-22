const path = require("path");

/** @type {import('next').NextConfig} */
module.exports = {
  // Emit a self-contained server (.next/standalone/server.js) so the runtime image is small and
  // needs no `npm install` — see the Dockerfile.
  output: "standalone",
  // Pin the file-tracing root to THIS app dir. Otherwise Next can infer a parent workspace root
  // (e.g. when a lockfile exists higher up, like examples/'s repo root) and nest the standalone
  // output under .next/standalone/examples/notes-next/, breaking the Dockerfile's
  // `COPY .next/standalone ./` + `CMD ["node","server.js"]`. With this, server.js stays top-level.
  outputFileTracingRoot: __dirname,
  // Keep `pg` as a real runtime dependency (don't bundle it into the server build); Next traces
  // it into the standalone output. Avoids bundler issues with node-postgres.
  serverExternalPackages: ["pg"],
};
