FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY package.json ./
# `pg` is pure JS (no native build) and tsx ships prebuilt binaries, so this stays fast and
# portable. We keep devDeps (tsx/typescript) since the app is run from TypeScript directly.
RUN npm install
COPY tsconfig.json server.ts ./
ENV PORT=8080
EXPOSE 8080
# No build step — tsx transpiles + runs server.ts on the fly.
CMD ["npx", "tsx", "server.ts"]
