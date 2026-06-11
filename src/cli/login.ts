import * as client from "openid-client";

export function devLoginToken(sub: string, email: string): string {
  return `${sub}:${email}`;
}

const GOOGLE_ISSUER = "https://accounts.google.com";
const CALLBACK_PORT = 8976;

/**
 * OAuth 2.0 authorization-code flow with PKCE + a localhost redirect against
 * Google. Returns the ID TOKEN (a JWT) — the API verifies that, not the opaque
 * access token.
 */
export async function googleBrowserLogin(clientId: string, clientSecret?: string): Promise<string> {
  const config = await client.discovery(new URL(GOOGLE_ISSUER), clientId, clientSecret);
  const redirectUri = `http://localhost:${CALLBACK_PORT}/callback`;
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const authUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid email",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  return await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port: CALLBACK_PORT,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
        try {
          const tokens = await client.authorizationCodeGrant(config, url, {
            pkceCodeVerifier: codeVerifier,
            expectedState: state,
          });
          const idToken = (tokens as any).id_token as string | undefined;
          if (!idToken) throw new Error("no id_token returned by Google");
          resolve(idToken);
          return new Response("<h1>Logged in to Drop. You can close this tab.</h1>", {
            headers: { "content-type": "text/html" },
          });
        } catch (e) {
          reject(e as Error);
          return new Response("login failed", { status: 400 });
        } finally {
          setTimeout(() => server.stop(true), 200);
        }
      },
    });

    console.log(`\nOpening your browser to sign in with Google…\nIf it doesn't open, visit:\n  ${authUrl.href}\n`);
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      Bun.spawn([opener, authUrl.href]);
    } catch {
      /* user can copy the URL */
    }
  });
}
