# SSO login setup (generic OIDC)

Drop's platform login is **server-mediated OIDC**: the api *is* the OAuth client — it owns
the provider credentials, runs the code exchange, maps the claims, and issues its own signed
session token. Clients (CLI + MCP + browser) only ever hold a Drop session, never the provider
secret. The provider is **generic** — Google is just the default issuer. Point Drop at Okta,
Microsoft Entra ID, Keycloak, Authentik, or any OIDC-compliant IdP.

> **One provider per deployment.** Multi-IdP is deliberately out of scope (it's enterprise-SSO
> scope creep). A deployment that needs two IdPs runs two Drop instances.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `DROP_OIDC_ISSUER` | `https://accounts.google.com` | Discovery base — Drop fetches `<issuer>/.well-known/openid-configuration`. |
| `DROP_OIDC_CLIENT_ID` | *(falls back to `DROP_GOOGLE_CLIENT_ID`)* | OAuth client id. |
| `DROP_OIDC_CLIENT_SECRET` | *(falls back to `DROP_GOOGLE_CLIENT_SECRET`)* | OAuth client secret (server-only). |
| `DROP_OIDC_SCOPES` | `openid email profile` | Scopes requested (add e.g. `groups` for the group gate). |
| `DROP_OIDC_EMAIL_CLAIM` | `email` | Claim carrying the email principal. |
| `DROP_OIDC_NAME_CLAIM` | `name` | Claim carrying the display name. |
| `DROP_OIDC_ALLOWED_DOMAINS` | *(falls back to `DROP_ALLOWED_DOMAINS`)* | Comma-separated email domains allowed to sign in. Empty = any. |
| `DROP_OIDC_GROUPS_CLAIM` | *(unset)* | Claim carrying the user's groups (array **or** space-joined string). |
| `DROP_OIDC_REQUIRED_GROUP` | *(unset)* | When set, login requires this group to be present in the groups claim. |
| `DROP_OIDC_DISPLAY_NAME` | *(derived from issuer host)* | Provider label on the sign-in button (e.g. `Entra ID`). |
| `DROP_SESSION_SECRET` | — (required) | HS256 key that signs Drop session tokens. `openssl rand -hex 32`. |
| `DROP_PUBLIC_URL` | `http://localhost:8080` | Externally reachable api base; its `/auth/callback` is the redirect URI. |

**Precedence — zero migration for Google deployments.** `DROP_OIDC_CLIENT_ID/SECRET` fall back to
the legacy `DROP_GOOGLE_CLIENT_ID/SECRET`, and `DROP_OIDC_ALLOWED_DOMAINS` falls back to
`DROP_ALLOWED_DOMAINS`. An existing Google deployment that sets none of the `DROP_OIDC_*` vars keeps
working unchanged (issuer defaults to Google). When both are set, the `DROP_OIDC_*` var wins.

**Claim gates.**
- **email** is required — a login token missing the configured email claim is rejected.
- `email_verified` is honored **only when present**: `false` → rejected; absent → accepted (many
  non-Google IdPs omit it for already-verified corporate accounts).
- **domain gate**: for Google the hosted-domain (`hd`) claim is trusted; every other issuer uses the
  email-domain suffix.
- **group gate** (optional): with `DROP_OIDC_REQUIRED_GROUP` set, the user's groups claim must contain
  that group. The claim may be a JSON array or a space-joined string — both are handled.

## Redirect URI

Register **exactly** this redirect URI in the provider's client config:

```
<DROP_PUBLIC_URL>/auth/callback
```

e.g. `https://api.drop.example.com/auth/callback` in production, or
`http://localhost:8473/auth/callback` for a local `make start` run.

## Per-provider recipes

### Google (default)

- Issuer: `https://accounts.google.com` (the default — leave `DROP_OIDC_ISSUER` unset).
- Create a **Web application** OAuth client in Google Cloud → Credentials.
- Scopes: `openid email profile`. Domain gate via `DROP_OIDC_ALLOWED_DOMAINS=yourco.com` (or the
  Workspace `hd` claim). Full walkthrough: this file's local-verify section below.

### Okta

- Issuer: `https://<your-org>.okta.com` (or a custom auth-server:
  `https://<your-org>.okta.com/oauth2/<authServerId>`).
- App type: **Web** → Authorization Code. Add the redirect URI above.
- Groups: add a `groups` claim to the ID token (Okta → Security → API → your auth server → Claims),
  then `DROP_OIDC_SCOPES="openid email profile groups"`, `DROP_OIDC_GROUPS_CLAIM=groups`,
  `DROP_OIDC_REQUIRED_GROUP=drop-users`.

### Microsoft Entra ID (Azure AD)

- Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`.
- Register an app; add a **Web** redirect URI (the one above); create a client secret.
- Entra's email is often in `preferred_username` or `upn`: set
  `DROP_OIDC_EMAIL_CLAIM=preferred_username` if `email` is absent. Name is `name`.
- Groups: enable the `groups` claim in Token configuration (or use `roles`), then set
  `DROP_OIDC_GROUPS_CLAIM=groups`. `DROP_OIDC_DISPLAY_NAME="Entra ID"`.

### Keycloak

- Issuer: `https://<host>/realms/<realm>` (e.g. `http://localhost:8580/realms/drop` locally).
- Create a **confidential** client (Client authentication ON), Standard flow (auth code) enabled,
  add the redirect URI above.
- Groups: add a **Group Membership** mapper named `groups` (token claim `groups`), then
  `DROP_OIDC_SCOPES="openid email profile"`, `DROP_OIDC_GROUPS_CLAIM=groups`.

### Authentik

- Issuer: `https://<host>/application/o/<app-slug>/`.
- Create an OAuth2/OpenID Provider + Application; client type **Confidential**; add the redirect URI.
- Scope mapping for groups exposes a `groups` array claim → `DROP_OIDC_GROUPS_CLAIM=groups`.

## Break-glass admin (emergency local login)

Email/password accounts are otherwise **out of Drop** (no signup, no password reset, no SMTP
dependency). The one exception is a single env-configured break-glass admin, for emergency access
when the IdP is unreachable. It's OFF unless `DROP_BREAK_GLASS_ADMIN` is set.

Generate the credential (scrypt via `node:crypto` — no extra dependency):

```bash
node -e 'const c=require("node:crypto"),[e,p]=process.argv.slice(1),s=c.randomBytes(16),k=c.scryptSync(p,s,64);console.log(`${e.toLowerCase()}:${s.toString("hex")}:${k.toString("hex")}`)' admin@example.com 'your-strong-password'
```

Set the output as `DROP_BREAK_GLASS_ADMIN`. Then `GET /auth/break-glass` renders a form and
`POST /auth/break-glass` (email + password) mints a **normal** Drop session. Every use is audited as
`auth.break_glass`. To make the break-glass admin a *platform* admin, also add its email to
`DROP_ADMINS`.

---

## Verify locally against a throwaway Keycloak

Drop ships a one-command local Keycloak for testing the generic OIDC path (also the test double for
Workstream K):

```bash
make keycloak        # runs quay.io/keycloak/keycloak:26 on :8580, admin/admin,
                     # imports infra/local/keycloak-realm.json (realm "drop",
                     # client "drop-console" / secret "drop-console-secret",
                     # user alice@example.com / password "alice")
```

Point Drop at it (opt-in; **not** wired into `make up`):

```bash
# in .env — the DROP_OIDC_* env to target the local Keycloak
DROP_DEV_AUTH=0
DROP_OIDC_ISSUER=http://localhost:8580/realms/drop
DROP_OIDC_CLIENT_ID=drop-console
DROP_OIDC_CLIENT_SECRET=drop-console-secret
DROP_OIDC_ALLOWED_DOMAINS=example.com
DROP_OIDC_DISPLAY_NAME=Keycloak
DROP_PUBLIC_URL=http://localhost:8473
DROP_SESSION_SECRET=$(openssl rand -hex 32)
```

```bash
make restart         # picks up .env → Keycloak SSO mode
make login           # browser → Keycloak → sign in alice@example.com / alice
```

The redirect URI `http://localhost:8473/auth/callback` is pre-registered on the `drop-console`
client in the imported realm. Stop it with `make keycloak-down`.

### Verify with real Google

Google permits `http://localhost` redirect URIs for **Web application** clients, so the full flow
also works on localhost with a real Google client:

1. Google Cloud → Credentials → **Create OAuth client ID** → **Web application**.
2. Authorized redirect URI: `http://localhost:8473/auth/callback` (must match `DROP_PUBLIC_URL`).
3. In `.env`: `DROP_DEV_AUTH=0`, `DROP_GOOGLE_CLIENT_ID=<id>`, `DROP_GOOGLE_CLIENT_SECRET=<secret>`
   (the OIDC issuer defaults to Google), `DROP_ALLOWED_DOMAINS=yourco.com`,
   `DROP_PUBLIC_URL=http://localhost:8473`, `DROP_SESSION_SECRET=$(openssl rand -hex 32)`.
4. `make restart && make login` → choose your account → "✓ Logged in to Drop."

## Troubleshooting

- **`redirect_uri_mismatch`** — the provider's registered redirect URI must be *exactly*
  `<DROP_PUBLIC_URL>/auth/callback`. Change both together if you move the api port.
- **TLS / `unable to get local issuer certificate`** reaching the issuer — set `NODE_EXTRA_CA_CERTS`
  to your corp CA bundle so node trusts your TLS-inspecting proxy.
- **"your account isn't allowed"** — the email domain isn't in `DROP_OIDC_ALLOWED_DOMAINS`,
  `email_verified` is `false`, or the required group is missing. The denial page names the reason.
- **"login token is missing the 'email' claim"** — the IdP isn't returning email under the default
  claim; set `DROP_OIDC_EMAIL_CLAIM` (Entra often needs `preferred_username`).
