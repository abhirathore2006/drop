# ---- build: compile the app + emit the standalone server ----
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# ---- runtime: a small, self-contained image (no npm install needed) ----
FROM docker.io/library/node:22-alpine
WORKDIR /app
# Next's standalone server reads PORT + HOSTNAME; bind 0.0.0.0 so it's reachable in the pod.
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
# .next/standalone contains server.js + only the node_modules Next traced (incl. pg).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8080
CMD ["node", "server.js"]
