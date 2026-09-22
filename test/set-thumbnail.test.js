import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { HANDLERS } from "../src/tools.js";
import { ChannelLock } from "../src/channel-lock.js";
import {
  ALLOWED_CHANNEL,
  ALLOWED_CHANNEL_RESPONSE,
  JPEG_BYTES,
  fakeYouTube,
  ownedVideo,
  resultJson,
  tempDir,
  testConfig,
  testCtx,
} from "./helpers.js";

async function fixture(video = ownedVideo()) {
  const dir = await tempDir("yt-mcp-thumb-");
  const media = path.join(dir, "media");
  await fs.mkdir(media, { recursive: true });
  await fs.writeFile(path.join(media, "ok.jpg"), JPEG_BYTES);

  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": { items: [video] },
    "thumbnails.set": { items: [] },
  });

  const config = testConfig({
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
    YOUTUBE_MEDIA_DIR: media,
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

  return { dir, media, youtube, ctx, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("a media-dir file is uploaded", async () => {
  const f = await fixture();
  try {
    const result = await HANDLERS.set_thumbnail(
      { videoId: "vid123", imagePath: "ok.jpg" },
      f.ctx
    );
    const payload = resultJson(result);

    assert.equal(payload.updated, true);
    assert.equal(payload.mimeType, "image/jpeg");

    const call = f.youtube.callsTo("thumbnails.set")[0];
    assert.equal(call.params.videoId, "vid123");
    assert.equal(call.params.media.mimeType, "image/jpeg");
    assert.equal(call.options.retry, false);
  } finally {
    await f.cleanup();
  }
});

test("exactly one of imagePath or imageUrl is required - neither is refused", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => HANDLERS.set_thumbnail({ videoId: "vid123" }, f.ctx),
      /exactly one of imagePath/
    );
    assert.equal(f.youtube.callsTo("thumbnails.set").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("supplying both is refused", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        HANDLERS.set_thumbnail(
          {
            videoId: "vid123",
            imagePath: "ok.jpg",
            imageUrl: "https://cdn.example.com/a.jpg",
          },
          f.ctx
        ),
      /exactly one of imagePath/
    );
    assert.equal(f.youtube.callsTo("thumbnails.set").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("ownership is checked before any media is read", async () => {
  const foreign = ownedVideo();
  foreign.snippet.channelId = "UCnotours0000000000000";
  const f = await fixture(foreign);
  try {
    await assert.rejects(
      () => HANDLERS.set_thumbnail({ videoId: "vid123", imagePath: "ok.jpg" }, f.ctx),
      /belongs to channel/
    );
    assert.equal(f.youtube.callsTo("thumbnails.set").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("a path escaping the media dir is refused and nothing is uploaded", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.dir, "outside.jpg"), JPEG_BYTES);

    await assert.rejects(
      () =>
        HANDLERS.set_thumbnail(
          { videoId: "vid123", imagePath: "../outside.jpg" },
          f.ctx
        ),
      /outside the configured media directory|not found inside/
    );
    assert.equal(f.youtube.callsTo("thumbnails.set").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("a blocked URL is refused before upload", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        HANDLERS.set_thumbnail(
          { videoId: "vid123", imageUrl: "http://169.254.169.254/latest" },
          f.ctx
        ),
      /only https/
    );
    assert.equal(f.youtube.callsTo("thumbnails.set").length, 0);
  } finally {
    await f.cleanup();
  }
});
