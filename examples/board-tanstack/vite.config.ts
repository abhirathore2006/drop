import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

// With this pinned @tanstack/react-start, `vite build` emits a Web-`fetch` SSR handler at
// dist/server/server.js plus hashed client assets in dist/client — it does NOT bundle its own
// listening server. server.js wraps that handler in @hono/node-server and binds PORT + HOST
// (8080 / 0.0.0.0), which is what the Dockerfile runs. `server.port` below only affects `vite dev`.
// (Newer Start versions default to a self-contained .output/server/index.mjs node-server instead.)
export default defineConfig({
  server: {
    port: 8080,
  },
  plugins: [
    tanstackStart(),
    // react's vite plugin must come AFTER start's plugin
    viteReact(),
  ],
})
