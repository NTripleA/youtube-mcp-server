/**
 * End-to-end through the real MCP protocol, over an in-memory transport.
 * Exercises tools/list and tools/call exactly as a client would.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/server.js";
import { ChannelLock } from "../src/channel-lock.js";
import {
  ALLOWED_CHANNEL,
  ALLOWED_CHANNEL_RESPONSE,
  fakeYouTube,
  ownedVideo,
  testConfig,
  testCtx,
} from "./helpers.js";

async function connect(ctx) {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function wiredYouTube() {
  return fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": { items: [ownedVideo()] },
    "videos.update": { id: "vid123" },
    "search.list": { items: [{ id: { videoId: "abc" } }] },
  });
}

test("tools/list over the protocol reflects the write gate", async () => {
  const youtube = wiredYouTube();
  const ctx = testCtx({ config: testConfig({ MCP_TRANSPORT: "http" }), youtube });
  const { client, close } = await connect(ctx);

  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    assert.equal(names.includes("update_video"), false);
    assert.equal(names.includes("youtube_start_oauth"), false);
    assert.ok(names.includes("search_videos"));
    assert.ok(names.includes("youtube_auth_status"));
  } finally {
    await close();
  }
});

test("a gated write called by name touches no Google client at all", async () => {
  const youtube = wiredYouTube();
  const ctx = testCtx({ config: testConfig({ MCP_TRANSPORT: "http" }), youtube });
  const { client, close } = await connect(ctx);

  try {
    const result = await client.callTool({
      name: "update_video",
      arguments: { videoId: "vid123", title: "sneaky" },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /YOUTUBE_ENABLE_WRITES/);
    // The decisive assertion: refusal happened before anything reached Google.
    assert.equal(youtube.calls.length, 0);
  } finally {
    await close();
  }
});

test("the local OAuth tool is refused over a remote-mode server", async () => {
  const youtube = wiredYouTube();
  const ctx = testCtx({
    config: testConfig({
      MCP_TRANSPORT: "http",
      YOUTUBE_ENABLE_WRITES: "true",
      YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
    }),
    youtube,
    startOAuth: async () => {
      throw new Error("this must never run");
    },
  });
  const { client, close } = await connect(ctx);

  try {
    const result = await client.callTool({
      name: "youtube_start_oauth",
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unavailable over HTTP/);
  } finally {
    await close();
  }
});

test("a permitted write runs end to end through the protocol", async () => {
  const youtube = wiredYouTube();
  const config = testConfig({
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });
  const ctx = testCtx({
    config,
    youtube,
    channelLock: new ChannelLock({
      youtube,
      allowedChannelId: ALLOWED_CHANNEL,
      log: null,
    }),
  });
  const { client, close } = await connect(ctx);

  try {
    const result = await client.callTool({
      name: "update_video",
      arguments: { videoId: "vid123", title: "New title" },
    });

    assert.notEqual(result.isError, true);
    assert.deepEqual(youtube.callsTo("videos.update")[0].params.part, ["snippet"]);
  } finally {
    await close();
  }
});

test("unknown arguments are rejected over the protocol", async () => {
  const youtube = wiredYouTube();
  const config = testConfig({
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });
  const ctx = testCtx({ config, youtube });
  const { client, close } = await connect(ctx);

  try {
    const result = await client.callTool({
      name: "update_video",
      arguments: { videoId: "vid123", titel: "typo" },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unknown field "titel"/);
    assert.equal(youtube.callsTo("videos.update").length, 0);
  } finally {
    await close();
  }
});

test("privacyStatus on update_video is refused over the protocol", async () => {
  const youtube = wiredYouTube();
  const config = testConfig({
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });
  const ctx = testCtx({ config, youtube });
  const { client, close } = await connect(ctx);

  try {
    const result = await client.callTool({
      name: "update_video",
      arguments: { videoId: "vid123", privacyStatus: "public" },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /set_video_privacy/);
    assert.equal(youtube.callsTo("videos.update").length, 0);
  } finally {
    await close();
  }
});

test("annotations survive the protocol round-trip", async () => {
  const config = testConfig({
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });
  const ctx = testCtx({ config, youtube: wiredYouTube() });
  const { client, close } = await connect(ctx);

  try {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    assert.equal(byName.search_videos.annotations.readOnlyHint, true);
    assert.equal(byName.reply_to_comment.annotations.idempotentHint, false);
    assert.equal(byName.update_video.annotations.destructiveHint, true);
    assert.equal(byName.set_thumbnail.annotations.destructiveHint, true);
    assert.equal(byName.set_video_privacy.annotations.destructiveHint, true);
  } finally {
    await close();
  }
});

test("an unknown tool is a protocol error", async () => {
  const ctx = testCtx({ youtube: wiredYouTube() });
  const { client, close } = await connect(ctx);

  try {
    await assert.rejects(
      () => client.callTool({ name: "delete_everything", arguments: {} }),
      /Tool not found/
    );
  } finally {
    await close();
  }
});

test("resources still list and read", async () => {
  const youtube = fakeYouTube({
    "videos.list": {
      items: [
        {
          id: "v1",
          snippet: { title: "Popular", channelTitle: "Chan" },
          statistics: { viewCount: "10" },
        },
      ],
    },
  });
  const ctx = testCtx({ youtube });
  const { client, close } = await connect(ctx);

  try {
    const { resources } = await client.listResources();
    assert.equal(resources[0].uri, "youtube://popular/videos");

    const read = await client.readResource({ uri: "youtube://popular/videos" });
    assert.match(read.contents[0].text, /Popular/);
  } finally {
    await close();
  }
});
