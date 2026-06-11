# Unified image: contains all bundles (api, edge, cli, mcp). The k8s Deployment
# overrides the command per role (node dist/api.js | node dist/edge.js).
#   podman build -f infra/Dockerfile -t <repo>/drop:<tag> .
FROM docker.io/library/node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts
COPY . .
RUN node build.mjs
EXPOSE 8080
CMD ["node", "dist/api.js"]
