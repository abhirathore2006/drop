#!/usr/bin/env bash
# Generate the TLS cert the nginx proxy uses for *.drop.localhost.
# Prefers mkcert (browser-trusted); falls back to a self-signed openssl cert.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs
CRT="certs/drop.localhost.pem"
KEY="certs/drop.localhost-key.pem"

if command -v mkcert >/dev/null 2>&1; then
  echo "▸ mkcert found — generating a browser-trusted cert…"
  mkcert -install >/dev/null 2>&1 || true
  mkcert -cert-file "$CRT" -key-file "$KEY" \
    "drop.localhost" "*.drop.localhost" "api.drop.localhost" "localhost" >/dev/null
  echo "✓ trusted cert written to infra/nginx/$CRT"
else
  echo "▸ mkcert not found — generating a self-signed cert with openssl…"
  echo "  (the browser will warn; install mkcert + re-run for a trusted cert)"
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$KEY" -out "$CRT" \
    -subj "/CN=*.drop.localhost" \
    -addext "subjectAltName=DNS:drop.localhost,DNS:*.drop.localhost,DNS:api.drop.localhost,DNS:localhost" \
    >/dev/null 2>&1
  echo "✓ self-signed cert written to infra/nginx/$CRT (untrusted)"
fi
