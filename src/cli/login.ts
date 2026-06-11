import * as client from "openid-client";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

export function devLoginToken(sub: string, email: string): string {
  return `${sub}:${email}`;
}

const GOOGLE_ISSUER = "https://accounts.google.com";
const CALLBACK_PORT = 8976;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.unref();
  } catch {
    /* user can copy the URL */
  }
}

/**
 * OAuth 2.0 authorization-code flow with PKCE + a localhost redirect against
 * Google. Returns the ID TOKEN (a JWT) — the API verifies that, not the opaque
 * access token. Uses node http/child_process so it runs under node or bun.
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
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      client
        .authorizationCodeGrant(config, url, { pkceCodeVerifier: codeVerifier, expectedState: state })
        .then((tokens) => {
          const idToken = (tokens as any).id_token as string | undefined;
          if (!idToken) throw new Error("no id_token returned by Google");
          res.setHeader("content-type", "text/html");
          res.end("<h1>Logged in to Drop. You can close this tab.</h1>");
          resolve(idToken);
        })
        .catch((e) => {
          res.statusCode = 400;
          res.end("login failed");
          reject(e as Error);
        })
        .finally(() => setTimeout(() => server.close(), 200));
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`\nOpening your browser to sign in with Google…\nIf it doesn't open, visit:\n  ${authUrl.href}\n`);
      openBrowser(authUrl.href);
    });
    server.on("error", reject);
  });
}
