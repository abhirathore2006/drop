# Organization root CAs (optional)

Drop your organization's **root CA certificate(s)** here as `*.crt` (PEM) to have the
container images trust them at runtime.

This is generic — it works for any organization. It's useful when the app egresses
through a **TLS-inspecting proxy** (the proxy re-signs HTTPS with an internal CA), so
that outbound calls — e.g. the API reaching `accounts.google.com` for Google login —
succeed instead of failing with `unable to verify the first certificate`.

```
infra/ca/
  your-org-root-ca.crt      # PEM-encoded root CA (add one or more)
```

The Dockerfiles copy everything here into the image's trust store and run
`update-ca-certificates`, then set `NODE_EXTRA_CA_CERTS` so Node trusts them. The
directory is **empty by default** (only this README + `.gitkeep`), so builds work with
no certs at all. Added `*.crt` files are git-ignored — they are never committed.

> Note: this is for *trusting outbound* TLS. The **local dev HTTPS server cert** for
> nginx (`*.drop.localhost`) is a separate thing — see `infra/nginx/gen-certs.sh`.
