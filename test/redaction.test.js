import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import {
  clearRegisteredSecrets,
  createLogger,
  isTransientError,
  redact,
  redactUrl,
  registerSecret,
  sanitizeGoogleError,
} from "../src/logger.js";
import { createMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ALLOWED_CHANNEL,
  ALLOWED_CHANNEL_RESPONSE,
  fakeYouTube,
  googleError,
  testConfig,
  testCtx,
} from "./helpers.js";

const ACCESS_TOKEN = "ya29.a0AfB_byC_FAKE_ACCESS_TOKEN_VALUE";
const REFRESH_TOKEN = "1//0gFAKE_REFRESH_TOKEN_VALUE_HERE";
const CLIENT_SECRET = "GOCSPX-FAKEcLiEnTsEcReT123";

test("token-shaped strings are masked", () => {
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) {
    const output = redact(`something went wrong with ${secret} here`);
    assert.equal(output.includes(secret), false, secret.slice(0, 12));
    assert.match(output, /\[redacted\]/);
  }
});

test("a JWT-shaped value is masked", () => {
  const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.signaturepart";
  assert.equal(redact(`id_token ${jwt}`).includes("signaturepart"), false);
});

test("explicitly registered secrets are masked even in unfamiliar shapes", () => {
  clearRegisteredSecrets();
  try {
    registerSecret("an-api-key-that-looks-like-nothing");
    const output = redact("request failed: key=an-api-key-that-looks-like-nothing");
    assert.equal(output.includes("an-api-key-that-looks-like-nothing"), false);
  } finally {
    clearRegisteredSecrets();
  }
});

test("keyed credential fields are masked whatever their value", () => {
  const output = redact('{"refresh_token":"whatever-value-here","x":1}');
  assert.equal(output.includes("whatever-value-here"), false);
});

test("redactUrl strips the query string and any embedded credentials", () => {
  assert.equal(
    redactUrl("https://cdn.example.com/a.jpg?X-Amz-Signature=SECRET"),
    "https://cdn.example.com/a.jpg?[redacted]"
  );
  assert.equal(
    redactUrl("https://user:pass@cdn.example.com/a.jpg"),
    "https://cdn.example.com/a.jpg"
  );
  assert.equal(redactUrl("not a url"), "[unparseable url]");
});

// -- Google errors ----------------------------------------------------------

test("a googleapis error is reduced to a safe summary", () => {
  const error = googleError("The request cannot be completed", {
    status: 403,
    secret: ACCESS_TOKEN,
  });
  error.errors = [{ reason: "quotaExceeded" }];

  const summary = sanitizeGoogleError(error);

  assert.match(summary, /The request cannot be completed/);
  assert.match(summary, /status 403/);
  assert.match(summary, /quotaExceeded/);
  // config.headers.Authorization and response.headers must never appear.
  assert.equal(summary.includes(ACCESS_TOKEN), false);
  assert.equal(summary.toLowerCase().includes("authorization"), false);
  assert.equal(summary.includes("Bearer"), false);
});

test("a token leaking through an error MESSAGE is still masked", () => {
  const error = new Error(`upstream said: Bearer ${ACCESS_TOKEN}`);
  assert.equal(sanitizeGoogleError(error).includes(ACCESS_TOKEN), false);
});

test("a tool error returned over the protocol leaks nothing", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": googleError("Forbidden", { status: 403, secret: ACCESS_TOKEN }),
  });
  const config = testConfig({
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });
  const server = createMcpServer(testCtx({ config, youtube }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const result = await client.callTool({
      name: "update_video",
      arguments: { videoId: "v", title: "x" },
    });

    const payload = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.equal(payload.includes(ACCESS_TOKEN), false, "access token leaked");
    assert.equal(payload.includes("Bearer"), false, "authorization header leaked");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the logger redacts everything it writes", () => {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const log = createLogger({ stream });

  log.info(`starting with token ${ACCESS_TOKEN}`);
  log.error(googleError("nope", { secret: ACCESS_TOKEN }));
  log.warn({ refresh_token: REFRESH_TOKEN });

  const output = chunks.join("");
  assert.equal(output.includes(ACCESS_TOKEN), false);
  assert.equal(output.includes(REFRESH_TOKEN), false);
  assert.match(output, /\[redacted\]/);
});

// -- transient classification ----------------------------------------------

test("transient failures are distinguished from definitive answers", () => {
  assert.equal(isTransientError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientError({ status: 503 }), true);
  assert.equal(isTransientError({ status: 429 }), true);

  // A definitive answer from Google is NOT transient: retrying forever would
  // hide a revoked token behind an "outage".
  assert.equal(isTransientError({ status: 403 }), false);
  assert.equal(isTransientError({ status: 401 }), false);
  assert.equal(isTransientError({ status: 404 }), false);
});
