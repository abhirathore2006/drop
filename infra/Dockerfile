# Unified image — contains all bundles (api, edge); the k8s Deployment overrides the
# command per role (node dist/api.js | node dist/edge.js). Copies the self-contained
# esbuild bundles (run `node build.mjs` first) — no in-image npm, so it builds offline
# / behind a TLS-inspecting proxy.
# To trust your organization's root CA at runtime, drop the cert(s) into infra/ca/*.crt.
#   node build.mjs && docker build -f infra/Dockerfile -t <repo>/drop:<tag> .
FROM docker.io/library/node:24-slim
WORKDIR /app

# Trust any organization root CA(s) placed in infra/ca/ (generic; empty by default).
COPY infra/ca/ /usr/local/share/ca-certificates/
RUN if ls /usr/local/share/ca-certificates/*.crt >/dev/null 2>&1; then update-ca-certificates; fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

COPY dist/ ./dist/
COPY docs ./docs
RUN printf '{"type":"module"}\n' > package.json
EXPOSE 8080
CMD ["node", "dist/api.js"]
