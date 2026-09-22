/**
 * The real HTTP transport, driven over real sockets.
 *
 * These are deliberately not handler-level tests: the point is the lifecycle -
 * a fresh Server and transport per request, concurrent clients not interfering,
 * header protection, body limits and cleanup.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startHttpTransport } from "../src/transports/http.js";
import { ChannelLock } from "../src/channel-lock.js";
import {
  ALLOWED_CHANNEL,
  ALLOWED_CHANNEL_RESPONSE,
  fakeYouTube,
  ownedVideo,
  tempDir,
  testConfig,
  testCtx,
} from "./helpers.js";

const PROTOCOL_VERSION = "2025-06-18";

function wiredYouTube() {
  return fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": { items: [ownedVideo()] },
    "videos.update": { id: "vid123" },
    "search.list": { items: [{ id: { videoId: "abc" } }] },
  });
}

/** Boot an HTTP server on an ephemeral port with the given env. */
async function boot(env = {}) {
  const dir = await tempDir("yt-mcp-http-");
  const youtube = wiredYouTube();

  const config = testConfig({
    MCP_TRANSPORT: "http",
    MCP_HTTP_PORT: "0",
    YOUTUBE_TOKEN_FILE: path.join(dir, "token.json"),
    ...env,
  });

  const ctx = testCtx({
    config,
    youtube,
    channelLock: new ChannelLock({
      youtube,
      allowedChannelId: config.allowedChannelId,
      log: null,
    }),
  });

  const handle = await startHttpTransport(ctx);
  const port = handle.address.port;

  return {
    port,
    youtube,
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      await handle.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Raw JSON-RPC POST over node:http rather than fetch.
 *
 * fetch() treats Host as a forbidden header and silently drops any override,
 * which would make the Host-rejection test pass vacuously. node:http sends
 * exactly what it is given.
 */
function rawPost(port, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: () => text,
            json: () => JSON.parse(text),
          });
        });
      }
    );

    let answered = false;
    request.on("error", (error) => {
      // A refused oversized upload can trip EPIPE on the write side after the
      // server has already replied; that is not a test failure.
      if (!answered) reject(error);
    });
    request.on("response", () => {
      answered = true;
    });
    request.end(payload);
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "raw-test", version: "1.0.0" },
  },
};

// -- health -----------------------------------------------------------------

test("the health endpoint is minimal and independent of Google", async () => {
  const server = await boot();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: "ok" });
    // No account diagnostics, no configuration, no outbound calls.
    assert.equal(server.youtube.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("an unknown path is a 404", async () => {
  const server = await boot();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/admin`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

// -- full client lifecycle --------------------------------------------------

async function connectClient(port) {
  const client = new Client({ name: "transport-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`)
  );
  // initialize + notifications/initialized happen inside connect().
  await client.connect(transport);
  return client;
}

test("initialize, initialized, tools/list and tools/call over real HTTP", async () => {
  const server = await boot({
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });

  try {
    const client = await connectClient(server.port);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("update_video"));
    assert.ok(names.includes("search_videos"));
    assert.equal(names.includes("youtube_start_oauth"), false);

    const result = await client.callTool({
      name: "update_video",
      arguments: { videoId: "vid123", title: "Over HTTP" },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(
      server.youtube.callsTo("videos.update")[0].params.requestBody.snippet.title,
      "Over HTTP"
    );

    await client.close();
  } finally {
    await server.close();
  }
});

test("two concurrent clients do not interfere", async () => {
  const server = await boot({
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });

  try {
    const [a, b] = await Promise.all([
      connectClient(server.port),
      connectClient(server.port),
    ]);

    // Interleave requests from both clients.
    const [listA, listB, callA, callB] = await Promise.all([
      a.listTools(),
      b.listTools(),
      a.callTool({ name: "search_videos", arguments: { query: "one" } }),
      b.callTool({ name: "search_videos", arguments: { query: "two" } }),
    ]);

    assert.equal(listA.tools.length, listB.tools.length);
    assert.notEqual(callA.isError, true);
    assert.notEqual(callB.isError, true);

    const queries = server.youtube
      .callsTo("search.list")
      .map((call) => call.params.q)
      .sort();
    assert.deepEqual(queries, ["one", "two"]);

    await Promise.all([a.close(), b.close()]);
  } finally {
    await server.close();
  }
});

test("the write gate is enforced over the wire", async () => {
  // Writes absent => OFF in remote mode.
  const server = await boot();

  try {
    const client = await connectClient(server.port);

    const { tools } = await client.listTools();
    assert.equal(
      tools.map((t) => t.name).includes("set_video_privacy"),
      false
    );

    const result = await client.callTool({
      name: "set_video_privacy",
      arguments: { videoId: "vid123", privacyStatus: "public" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /YOUTUBE_ENABLE_WRITES/);
    assert.equal(server.youtube.calls.length, 0);

    await client.close();
  } finally {
    await server.close();
  }
});

test("the local-only OAuth tool is refused over HTTP by name", async () => {
  const server = await boot({
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });

  try {
    const client = await connectClient(server.port);
    const result = await client.callTool({
      name: "youtube_start_oauth",
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unavailable over HTTP/);

    await client.close();
  } finally {
    await server.close();
  }
});

// -- header protection ------------------------------------------------------

test("an unlisted Host header is rejected with 403", async () => {
  const server = await boot();
  try {
    const response = await rawPost(server.port, INITIALIZE, {
      host: "evil.example.com",
    });

    assert.equal(response.status, 403);
    const body = response.json();
    assert.match(JSON.stringify(body), /Invalid Host header/);
  } finally {
    await server.close();
  }
});

test("a loopback Host header is always accepted", async () => {
  const server = await boot();

  try {
    // The default allowlist covers 127.0.0.1:<port> with no configuration.
    const response = await rawPost(server.port, INITIALIZE);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("a PRESENT but unlisted Origin is rejected", async () => {
  const server = await boot({
    MCP_ALLOWED_ORIGINS: "https://claude.ai",
  });

  try {
    const response = await rawPost(server.port, INITIALIZE, {
      origin: "https://evil.example.com",
    });

    assert.equal(response.status, 403);
    assert.match(JSON.stringify(response.json()), /Invalid Origin header/);
  } finally {
    await server.close();
  }
});

test("a listed Origin is accepted", async () => {
  const server = await boot({
    MCP_ALLOWED_ORIGINS: "https://claude.ai",
  });

  try {
    const response = await rawPost(server.port, INITIALIZE, {
      origin: "https://claude.ai",
    });
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("a MISSING Origin is accepted - server-to-server clients do not send one", async () => {
  const server = await boot({
    MCP_ALLOWED_ORIGINS: "https://claude.ai",
  });

  try {
    const response = await rawPost(server.port, INITIALIZE);
    assert.equal(
      response.status,
      200,
      "omitting Origin must not be treated as an invalid Origin"
    );
  } finally {
    await server.close();
  }
});

// -- request handling -------------------------------------------------------

test("an oversized body is rejected with 413", async () => {
  const server = await boot();
  try {
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { padding: "x".repeat(2 * 1024 * 1024) },
    });

    const response = await rawPost(server.port, huge);

    assert.equal(response.status, 413);
    assert.match(JSON.stringify(response.json()), /too large/i);
  } finally {
    await server.close();
  }
});

test("malformed JSON is a parse error, not a crash", async () => {
  const server = await boot();
  try {
    const response = await rawPost(server.port, "{ this is not json");

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.json()), /Parse error/);

    // The server is still alive afterwards.
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await server.close();
  }
});

test("many sequential requests do not leak listeners", async () => {
  const server = await boot();

  try {
    for (let i = 0; i < 25; i += 1) {
      const response = await rawPost(server.port, { ...INITIALIZE, id: i });
      assert.equal(response.status, 200);
      await response.text();
    }

    // A per-request Server that was never cleaned up would show here.
    assert.ok(
      process.listenerCount("uncaughtException") < 5,
      "per-request transports must be cleaned up"
    );
  } finally {
    await server.close();
  }
});

test("stateless mode issues no session id", async () => {
  const server = await boot();

  try {
    const response = await rawPost(server.port, INITIALIZE);
    assert.equal(response.status, 200);
    assert.equal(response.headers["mcp-session-id"] ?? null, null);
  } finally {
    await server.close();
  }
});

test("the default bind address is loopback only", async () => {
  const config = testConfig({ MCP_TRANSPORT: "http" });
  assert.equal(config.http.host, "127.0.0.1");
});
