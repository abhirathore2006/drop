// Production Node entry. `vite build` (the tanstackStart() plugin) emits two halves:
//   - dist/server/server.js  → the SSR request handler; default export has `fetch(request)`
//   - dist/client/           → hashed static assets (JS/CSS) referenced by the rendered HTML
// This version of TanStack Start does NOT bundle its own listening server, so we provide one:
// `@hono/node-server` (pure JS, no native build) turns a Web-`fetch` handler into a Node HTTP
// server, and we serve the immutable /assets/* files ourselves before delegating to SSR.
// Binds HOST (default 0.0.0.0) : PORT (default 8080) — what the Dockerfile / drop.yaml expect.
import { serve } from '@hono/node-server'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize } from 'node:path'
import ssr from './dist/server/server.js'

const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'
const root = dirname(fileURLToPath(import.meta.url))
const clientDir = join(root, 'dist', 'client')

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

// Serve a hashed client asset if the request maps to a real file under dist/client; else null.
async function tryStatic(pathname) {
  // normalize() + the clientDir prefix check prevents path traversal out of dist/client.
  const filePath = normalize(join(clientDir, decodeURIComponent(pathname)))
  if (!filePath.startsWith(clientDir)) return null
  try {
    const s = await stat(filePath)
    if (!s.isFile()) return null
    const ext = filePath.slice(filePath.lastIndexOf('.'))
    const body = Readable.toWeb(createReadStream(filePath))
    return new Response(body, {
      headers: {
        'content-type': MIME[ext] || 'application/octet-stream',
        // hashed filenames are content-addressed → safe to cache forever
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return null
  }
}

serve({ fetch: handler, port: PORT, hostname: HOST }, () =>
  console.log(`board: listening on http://${HOST}:${PORT}`),
)

async function handler(request) {
  const { pathname } = new URL(request.url)
  if (pathname.startsWith('/assets/')) {
    const asset = await tryStatic(pathname)
    if (asset) return asset
  }
  // Everything else (pages, /healthz, server functions) → the TanStack Start SSR handler.
  return ssr.fetch(request)
}
