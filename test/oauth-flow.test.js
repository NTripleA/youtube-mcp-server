/**
 * The loopback + PKCE authorization flow.
 *
 * Google deprecated the out-of-band "paste the code back" flow the original
 * server relied on. These tests pin the supported Desktop-app behaviour.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { runLoopbackOAuth } from "../src/oauth-flow.js";
import { SCOPES } from "../src/auth.js";
import { TokenStore } from "../src/auth.js";
import { tempDir, testConfig } from "./helpers.js";

/** Drive the flow by playing the browser: fetch the redirect URI ourselves. */
async function driveFlow({
  tokenFile,
  existing = null,
  tokens = { access_token: "a", refresh_token: "r", scope: SCOPES.join(" ") },
  mutateCallbackUrl = (url) => url,
  getTokenImpl,
}) {
  const config = testConfig({
    YOUTUBE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    YOUTUBE_CLIENT_SECRET: "GOCSPX-test-secret-value",
    YOUTUBE_TOKEN_FILE: tokenFile,
  });

  const store = new TokenStore(tokenFile);
  if (existing) await store.save(existing);

  const captured = {};

  const promise = runLoopbackOAuth({
    config,
    tokenStore: store,
    log: null,
    timeoutMs: 5000,
    onAuthUrl: async (authUrl) => {
      captured.authUrl = new URL(authUrl);
      const redirectUri = captured.authUrl.searchParams.get("redirect_uri");
      const state = captured.authUrl.searchParams.get("state");
      captured.redirectUri = redirectUri;
      captured.state = state;

      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "auth-code-123");
      callback.searchParams.set("state", state);

      const finalUrl = mutateCallbackUrl(callback);
      // Give the listener a tick to be wired up before the "browser" arrives.
      queueMicrotask(() => {
        fetch(finalUrl.toString()).catch(() => {});
      });
    },
  });

  return { promise, captured, config, store, getTokenImpl };
}

/**
 * Patch the OAuth2 client's token exchange. The flow builds its own client, so
 * we stub at the prototype for the duration of one test.
 */
async function withStubbedTokenExchange(impl, fn) {
  const { google } = await import("googleapis");
  const proto = google.auth.OAuth2.prototype;
  const originalGetToken = proto.getToken;
  const originalRequest = proto.request;

  proto.getToken = impl;
  // channels.list read-back: make it fail fast and harmlessly.
  proto.request = async () => {
    throw new Error("network disabled in tests");
  };

  try {
    return await fn();
  } finally {
    proto.getToken = originalGetToken;
    proto.request = originalRequest;
  }
}

test("the authorization URL uses PKCE, offline access and the minimum scopes", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");

  try {
    await withStubbedTokenExchange(
      async function () {
        return { tokens: { access_token: "a", refresh_token: "r", scope: SCOPES.join(" ") } };
      },
      async () => {
        const { promise, captured } = await driveFlow({ tokenFile });
        await promise;

        const params = captured.authUrl.searchParams;
        assert.equal(params.get("access_type"), "offline");
        assert.equal(params.get("prompt"), "consent");
        assert.equal(params.get("code_challenge_method"), "S256");
        assert.ok(params.get("code_challenge"), "a PKCE challenge must be sent");
        assert.ok(params.get("state"), "a state value must be sent");

        const scope = params.get("scope");
        for (const expected of SCOPES) {
          assert.ok(scope.includes(expected), `scope ${expected} must be requested`);
        }
        // The broad write-capable scope must NOT be requested.
        assert.equal(
          scope.includes("https://www.googleapis.com/auth/youtube "),
          false,
          "the broad youtube scope must not be requested"
        );
      }
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the redirect is a loopback URI, never the deprecated OOB value", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");

  try {
    await withStubbedTokenExchange(
      async () => ({ tokens: { access_token: "a", refresh_token: "r" } }),
      async () => {
        const { promise, captured } = await driveFlow({ tokenFile });
        await promise;

        const redirect = new URL(captured.redirectUri);
        assert.equal(redirect.hostname, "127.0.0.1");
        assert.equal(redirect.pathname, "/oauth2callback");
        assert.notEqual(redirect.port, "1", "the old placeholder port is gone");
        assert.ok(Number(redirect.port) > 1024, "an ephemeral port is used");
        assert.equal(captured.redirectUri.includes("urn:ietf:wg:oauth"), false);
      }
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the code verifier is sent to the token endpoint", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");
  let seenRequest = null;

  try {
    await withStubbedTokenExchange(
      async function (request) {
        seenRequest = request;
        return { tokens: { access_token: "a", refresh_token: "r" } };
      },
      async () => {
        const { promise } = await driveFlow({ tokenFile });
        await promise;
      }
    );

    assert.equal(seenRequest.code, "auth-code-123");
    assert.ok(seenRequest.codeVerifier, "the PKCE verifier must be sent");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a mismatched state parameter is rejected", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");

  try {
    await withStubbedTokenExchange(
      async () => ({ tokens: { access_token: "a", refresh_token: "r" } }),
      async () => {
        const { promise } = await driveFlow({
          tokenFile,
          mutateCallbackUrl: (url) => {
            url.searchParams.set("state", "attacker-supplied-state");
            return url;
          },
        });

        await assert.rejects(() => promise, /State parameter mismatch/);
      }
    );

    // Nothing was written.
    await assert.rejects(() => fs.stat(tokenFile), /ENOENT/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an error returned by Google is surfaced", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");

  try {
    await withStubbedTokenExchange(
      async () => ({ tokens: {} }),
      async () => {
        const { promise } = await driveFlow({
          tokenFile,
          mutateCallbackUrl: (url) => {
            url.searchParams.delete("code");
            url.searchParams.set("error", "access_denied");
            return url;
          },
        });

        await assert.rejects(() => promise, /Authorization was refused: access_denied/);
      }
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the listener is closed after a single exchange", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");

  try {
    await withStubbedTokenExchange(
      async () => ({ tokens: { access_token: "a", refresh_token: "r" } }),
      async () => {
        const { promise, captured } = await driveFlow({ tokenFile });
        await promise;

        // The port must no longer accept connections.
        await assert.rejects(
          () => fetch(captured.redirectUri),
          "the temporary listener must not outlive the flow"
        );
      }
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a consent response without a refresh token does not clobber a stored one", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");

  try {
    await withStubbedTokenExchange(
      async () => ({ tokens: { access_token: "new-access" } }),
      async () => {
        const { promise } = await driveFlow({
          tokenFile,
          existing: { access_token: "old", refresh_token: "PRECIOUS-REFRESH-TOKEN" },
        });
        const result = await promise;

        assert.equal(result.refreshTokenStored, true);
      }
    );

    const stored = await new TokenStore(tokenFile).load();
    assert.equal(stored.refresh_token, "PRECIOUS-REFRESH-TOKEN");
    assert.equal(stored.access_token, "new-access");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("no refresh token anywhere is reported as a provisioning problem", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");

  try {
    await withStubbedTokenExchange(
      async () => ({ tokens: { access_token: "only-access" } }),
      async () => {
        const { promise } = await driveFlow({ tokenFile });
        await assert.rejects(() => promise, /no refresh token/);
      }
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("granted scopes are read back from the token, not from the request", async () => {
  const dir = await tempDir("yt-mcp-oauth-");
  const tokenFile = path.join(dir, "token.json");

  try {
    await withStubbedTokenExchange(
      async () => ({
        tokens: {
          access_token: "a",
          refresh_token: "r",
          // Google granted FEWER scopes than we asked for.
          scope: "https://www.googleapis.com/auth/youtube.readonly",
        },
      }),
      async () => {
        const { promise } = await driveFlow({ tokenFile });
        const result = await promise;

        assert.deepEqual(result.scopesGranted, [
          "https://www.googleapis.com/auth/youtube.readonly",
        ]);
        assert.notDeepEqual(result.scopesGranted, [...SCOPES]);
      }
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an unconfigured OAuth client is refused before any listener opens", async () => {
  await assert.rejects(
    () =>
      runLoopbackOAuth({
        config: testConfig({}),
        tokenStore: new TokenStore("/tmp/never-written.json"),
      }),
    /OAuth is not configured/
  );
});
