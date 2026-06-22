// Plain-text liveness probe. A route with only a `server.handlers` block (no component) — TanStack
// Start serves it straight from the Node server, returning "ok" so the platform's health checks
// pass even before any DB activity. Mirrors the guestbook /healthz.
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: () => new Response('ok', { headers: { 'content-type': 'text/plain' } }),
    },
  },
})
