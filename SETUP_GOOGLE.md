# Verify Google login end-to-end (local)

Server-mediated login works fully on localhost — Google permits `http://localhost`
redirect URIs for **Web application** OAuth clients. ~10 minutes.

## 1. Create a Google OAuth client

1. Go to <https://console.cloud.google.com> → pick (or create) a project.
2. **APIs & Services → OAuth consent screen**
   - User type: **Internal** (your `paytm.com` Workspace — limits sign-in to the org,
     no Google verification needed). App name: `Drop (local)`. Add your email. Save.
   - Scopes: add `openid` and `.../auth/userinfo.email` (both non-sensitive). Save.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**. Name: `Drop local`.
   - **Authorized redirect URIs → ADD:**  `http://localhost:8080/auth/callback`
     (exactly — scheme, host, port, path must match `DROP_PUBLIC_URL` + `/auth/callback`).
   - Create. Copy the **Client ID** and **Client secret**.

## 2. Configure the local server

```bash
cd drop
cp .env.example .env
# edit .env:
#   DROP_DEV_AUTH=0
#   DROP_GOOGLE_CLIENT_ID=<client id>
#   DROP_GOOGLE_CLIENT_SECRET=<client secret>
#   DROP_PUBLIC_URL=http://localhost:8080
#   DROP_ALLOWED_DOMAINS=paytm.com
#   DROP_SESSION_SECRET=<paste: openssl rand -hex 32>
#   NODE_EXTRA_CA_CERTS=~/certs/ca-bundle-with-zscaler.pem   # if behind Zscaler
openssl rand -hex 32          # paste into DROP_SESSION_SECRET
```

`.env` is gitignored — secrets stay local.

## 3. Run and sign in

```bash
make setup        # once (node + deps + podman VM + Floci image)
make restart      # picks up .env → Google mode
```

The api log should print `OAuth callback: http://localhost:8080/auth/callback`.
Then:

```bash
make login        # opens your browser → choose your @paytm.com account → consent
                  # browser shows "✓ Logged in to Drop. You can close this tab."
                  # terminal prints "✓ logged in"
```

## 4. Verify it's real auth (not dev-auth)

```bash
# the stored token is a signed JWT, not a "sub:email" dev token:
cat ~/.config/drop/session.json        # token starts with eyJ...

# publish with the real session and serve it:
mkdir -p /tmp/g && echo '<h1>real google auth</h1>' > /tmp/g/index.html
make publish DIR=/tmp/g NAME=gtest
curl -H 'Host: gtest.drop.localhost' http://localhost:8090/

# a forged/garbage token is rejected:
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer not-a-jwt' http://localhost:8080/v1/sites   # 401
```

To switch back to frictionless dev mode: delete (or rename) `.env`, `make restart`.

## Troubleshooting

- **`redirect_uri_mismatch`** — the URI in the Google client must be *exactly*
  `http://localhost:8080/auth/callback` (matches `DROP_PUBLIC_URL`). If you change
  the API port, update both.
- **TLS / `unable to get local issuer certificate`** reaching `accounts.google.com`
  — set `NODE_EXTRA_CA_CERTS` to your corp CA bundle in `.env`.
- **"account not allowed"** — your account's domain isn't in `DROP_ALLOWED_DOMAINS`
  (or `email_verified` is false). Set it to your domain, or empty to allow any.
- **Consent screen "App is blocked"** — make sure the consent screen is **Internal**
  and you're signing in with an org account.
- **`make login` hangs** — the API didn't receive the callback; check the api log
  (`make logs`) and that the browser reached `http://localhost:8080/auth/callback`.
