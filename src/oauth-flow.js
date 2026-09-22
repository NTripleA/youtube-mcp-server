/**
 * Google Desktop-app OAuth via the supported loopback redirect, with PKCE.
 *
 * Google deprecated the out-of-band ("copy this code back into the app") flow,
 * which is what the previous `http://localhost:1` redirect forced. This uses a
 * temporary listener on 127.0.0.1 at an ephemeral port instead: the browser is
 * redirected straight back to it, so no authorization code is ever handled by
 * the operator, and none is ever handled over the remote MCP.
 */

import http from "node:http";
import crypto from "node:crypto";
import { google } from "googleapis";
import { SCOPES, grantedScopes } from "./auth.js";
import { sanitizeGoogleError } from "./logger.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const CALLBACK_PATH = "/oauth2callback";

function htmlResponse(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1>${title}</h1><p>${message}</p></body>`;
}

/**
 * Run the full loopback flow and persist the resulting credentials.
 *
 * @param {{config: object, tokenStore: object, log?: object,
 *          onAuthUrl?: (url: string) => void, timeoutMs?: number}} options
 */
export async function runLoopbackOAuth({
  config,
  tokenStore,
  log = null,
  onAuthUrl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!config.oauth.configured) {
    throw new Error(
      "OAuth is not configured. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET " +
        "from a Google Cloud OAuth client of type 'Desktop app'."
    );
  }

  const state = crypto.randomBytes(24).toString("hex");

  const { server, port } = await listenOnEphemeralPort();
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  const oauth2Client = new google.auth.OAuth2(
    config.oauth.clientId,
    config.oauth.clientSecret,
    redirectUri
  );

  const { codeVerifier, codeChallenge } = await oauth2Client.generateCodeVerifierAsync();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    // Forces a refresh token even when this account has consented before.
    prompt: "consent",
    scope: [...SCOPES],
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    state,
  });

  onAuthUrl?.(authUrl);

  let code;
  try {
    code = await waitForCallback(server, { state, timeoutMs });
  } finally {
    // Single exchange only: the listener never outlives the flow.
    await new Promise((resolve) => server.close(resolve));
  }

  let tokens;
  try {
    ({ tokens } = await oauth2Client.getToken({ code, codeVerifier }));
  } catch (error) {
    throw new Error(`Token exchange failed: ${sanitizeGoogleError(error)}`);
  }

  // A consent response without a refresh token must never overwrite a working
  // one. The store merges rather than replaces, so the check here is only about
  // reporting a genuine provisioning problem.
  const existing = await tokenStore.load();
  if (!tokens.refresh_token && !existing?.refresh_token) {
    throw new Error(
      "Authorization succeeded but Google returned no refresh token, and none " +
        "is stored. This deployment would stop working at the next access-token " +
        "expiry. Revoke this app's access at https://myaccount.google.com/permissions " +
        "and run `npm run auth` again so consent is granted fresh."
    );
  }

  const saved = await tokenStore.save(tokens);

  if (!tokens.refresh_token && existing?.refresh_token) {
    log?.warn(
      "Google returned no new refresh token; the existing stored refresh token " +
        "was preserved."
    );
  }

  oauth2Client.setCredentials(saved);

  // Read back who we actually authenticated as. This is the value that must
  // match YOUTUBE_ALLOWED_CHANNEL_ID on the deployment.
  let channel = null;
  try {
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });
    const response = await youtube.channels.list({
      part: ["id", "snippet"],
      mine: true,
    });
    const item = response.data?.items?.[0];
    if (item) channel = { id: item.id, title: item.snippet?.title ?? null };
  } catch (error) {
    log?.warn(`Could not read back the channel: ${sanitizeGoogleError(error)}`);
  }

  return {
    tokenFile: config.tokenFile,
    refreshTokenStored: Boolean(saved.refresh_token),
    // From the grant, not from what we asked for.
    scopesGranted: grantedScopes(saved),
    channel,
  };
}

function listenOnEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function waitForCallback(server, { state, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for authorization`));
    }, timeoutMs);

    const finish = (error, value) => {
      clearTimeout(timer);
      server.removeListener("request", onRequest);
      if (error) reject(error);
      else resolve(value);
    };

    const onRequest = (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      const params = url.searchParams;
      const send = (status, title, message) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlResponse(title, message));
      };

      const error = params.get("error");
      if (error) {
        send(400, "Authorization failed", `Google reported: ${error}`);
        finish(new Error(`Authorization was refused: ${error}`));
        return;
      }

      // CSRF protection: the state we generated must come back unchanged.
      if (params.get("state") !== state) {
        send(400, "Authorization failed", "State parameter mismatch.");
        finish(new Error("State parameter mismatch - authorization rejected"));
        return;
      }

      const code = params.get("code");
      if (!code) {
        send(400, "Authorization failed", "No authorization code was returned.");
        finish(new Error("No authorization code was returned"));
        return;
      }

      send(200, "Authorization complete", "You can close this tab and return to the terminal.");
      finish(null, code);
    };

    server.on("request", onRequest);
  });
}
