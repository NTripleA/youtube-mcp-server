/**
 * The public read path must keep working exactly as it did before: an API key,
 * no OAuth, no token file, no channel lock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, buildGoogleClients } from "../src/tools.js";
import { validateStartup, createContext } from "../src/bootstrap.js";
import {
  fakeAnalytics,
  fakeYouTube,
  resultJson,
  testConfig,
  tempDir,
} from "./helpers.js";
import fs from "node:fs/promises";
import path from "node:path";

function apiKeyOnlyCtx(youtube) {
  const config = testConfig({ YOUTUBE_API_KEY: "key-only" });
  return {
    config,
    log: null,
    youtube,
    youtubeAnalytics: null,
    channelLock: null,
    credentials: null,
  };
}

test("search_videos works with an API key and no OAuth", async () => {
  const youtube = fakeYouTube({
    "search.list": { items: [{ id: { videoId: "abc" } }] },
  });

  const result = await HANDLERS.search_videos({ query: "cats" }, apiKeyOnlyCtx(youtube));

  assert.deepEqual(resultJson(result).items[0].id, { videoId: "abc" });
  assert.deepEqual(youtube.callsTo("search.list")[0].params.type, ["video"]);
});

test("get_video_details works with an API key and no OAuth", async () => {
  const youtube = fakeYouTube({
    "videos.list": { items: [{ id: "abc", snippet: { title: "A video" } }] },
  });

  const result = await HANDLERS.get_video_details({ videoId: "abc" }, apiKeyOnlyCtx(youtube));

  assert.equal(resultJson(result).snippet.title, "A video");
});

test("get_video_details reports a missing video plainly", async () => {
  const youtube = fakeYouTube({ "videos.list": { items: [] } });
  await assert.rejects(
    () => HANDLERS.get_video_details({ videoId: "nope" }, apiKeyOnlyCtx(youtube)),
    /not found/
  );
});

test("list_comments works with an API key and no OAuth", async () => {
  const youtube = fakeYouTube({
    "commentThreads.list": { items: [{ id: "t1" }] },
  });

  const result = await HANDLERS.list_comments({ videoId: "abc" }, apiKeyOnlyCtx(youtube));

  assert.equal(resultJson(result)[0].id, "t1");
});

test("read tools need no channel lock at all", async () => {
  const youtube = fakeYouTube({ "search.list": { items: [] } });
  const ctx = apiKeyOnlyCtx(youtube);

  assert.equal(ctx.channelLock, null);
  await HANDLERS.search_videos({ query: "x" }, ctx); // does not throw
  assert.equal(youtube.callsTo("channels.list").length, 0);
});

test("a write refuses cleanly when OAuth is absent", async () => {
  const youtube = fakeYouTube({});
  await assert.rejects(
    () => HANDLERS.update_video({ videoId: "v", title: "x" }, apiKeyOnlyCtx(youtube)),
    /OAuth is not configured/
  );
  assert.equal(youtube.callsTo("videos.update").length, 0);
});

test("analytics reports a clear message when OAuth is absent", async () => {
  await assert.rejects(
    () =>
      HANDLERS.analytics_top_videos(
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        apiKeyOnlyCtx(fakeYouTube({}))
      ),
    /requires OAuth credentials/
  );
});

test("analytics is available at startup, not only after authorization", () => {
  // The original server built the analytics client inside the authorize
  // handler, so both analytics tools broke after every restart.
  const oauth2Client = { fake: true };
  const clients = buildGoogleClients({ oauth2Client, apiKey: null });

  assert.ok(clients.youtube);
  assert.ok(clients.youtubeAnalytics, "analytics must exist without re-authorizing");
});

test("analytics queries are scoped to the authenticated channel", async () => {
  const analytics = fakeAnalytics({ "reports.query": { rows: [["v1", 10]] } });
  const ctx = { ...apiKeyOnlyCtx(fakeYouTube({})), youtubeAnalytics: analytics };

  await HANDLERS.analytics_top_videos(
    { startDate: "2026-01-01", endDate: "2026-01-31", metric: "views" },
    ctx
  );

  assert.equal(analytics.calls[0].params.ids, "channel==MINE");
  assert.equal(analytics.calls[0].params.sort, "-views");
});

test("auth status is safe to call with no credentials", async () => {
  const ctx = apiKeyOnlyCtx(fakeYouTube({}));
  const status = resultJson(await HANDLERS.youtube_auth_status({}, ctx));

  assert.equal(status.oauthConfigured, false);
  assert.equal(status.apiKeyPresent, true);
  assert.equal(status.tokenPresent, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.scopesGranted, "unknown");
  assert.equal(JSON.stringify(status).includes("key-only"), false, "no secret values");
});

// -- startup ----------------------------------------------------------------

test("an API-key-only stdio deployment starts fine", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig({
      YOUTUBE_TOKEN_FILE: path.join(dir, "token.json"),
      YOUTUBE_ENABLE_WRITES: "false",
    });
    const ctx = await createContext(config, { log: null });
    const { fatal } = await validateStartup(ctx);

    assert.equal(fatal, null);
    assert.ok(ctx.youtube, "read client available");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a deployment with no credentials at all is refused", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig({
      YOUTUBE_API_KEY: "",
      YOUTUBE_TOKEN_FILE: path.join(dir, "token.json"),
    });
    const ctx = await createContext(config, { log: null });
    const { fatal } = await validateStartup(ctx);

    assert.match(fatal, /No credentials/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("remote mode with writes enabled requires an allowed channel", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig({
      MCP_TRANSPORT: "http",
      YOUTUBE_ENABLE_WRITES: "true",
      YOUTUBE_TOKEN_FILE: path.join(dir, "token.json"),
    });
    const ctx = await createContext(config, { log: null });
    const { fatal } = await validateStartup(ctx);

    assert.match(fatal, /YOUTUBE_ALLOWED_CHANNEL_ID is required/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a writes-disabled remote deployment needs no allowed channel", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig({
      MCP_TRANSPORT: "http",
      YOUTUBE_TOKEN_FILE: path.join(dir, "token.json"),
    });
    const ctx = await createContext(config, { log: null });
    const { fatal } = await validateStartup(ctx);

    assert.equal(fatal, null, "a read-only remote deployment has nothing to lock");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the interactive OAuth entry point exists only in stdio mode", async () => {
  const dir = await tempDir();
  try {
    const stdio = await createContext(
      testConfig({ YOUTUBE_TOKEN_FILE: path.join(dir, "a.json") }),
      { log: null }
    );
    const remote = await createContext(
      testConfig({
        MCP_TRANSPORT: "http",
        YOUTUBE_TOKEN_FILE: path.join(dir, "b.json"),
      }),
      { log: null }
    );

    assert.equal(typeof stdio.startOAuth, "function");
    assert.equal(remote.startOAuth, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
