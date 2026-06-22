FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY package.json ./
# express, ejs and pg are all pure JS (no native build), so this stays fast and portable.
RUN npm install --omit=dev
COPY server.js ./
COPY views ./views
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
