/** @type {import('next').NextConfig} */
module.exports = {
  // Emit a self-contained server (.next/standalone/server.js) so the runtime image is small and
  // needs no `npm install` — see the Dockerfile.
  output: "standalone",
  // Keep `pg` as a real runtime dependency (don't bundle it into the server build); Next traces
  // it into the standalone output. Avoids bundler issues with node-postgres.
  serverExternalPackages: ["pg"],
};
