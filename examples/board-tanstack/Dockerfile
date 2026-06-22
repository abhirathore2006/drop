# ---- build: install all deps + run `vite build` (emits the SSR handler + client assets) ----
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json ./
# devDeps (vite, the start plugin, the react plugin) are needed to build, so a full install.
RUN npm install
COPY . .
# `vite build` generates src/routeTree.gen.ts, dist/client/ (assets) and dist/server/server.js.
RUN npm run build

# ---- deps: just the PRODUCTION node_modules the runtime needs (pg, react, tanstack, hono) ----
# Kept separate so the runtime image carries no vite/build toolchain.
FROM docker.io/library/node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# ---- runtime: small image that runs server.js (binds HOST:PORT, serves dist/) ----
FROM docker.io/library/node:22-alpine
WORKDIR /app
# server.js reads PORT + HOST; bind 0.0.0.0 so it's reachable in the pod.
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY package.json server.js ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "server.js"]
