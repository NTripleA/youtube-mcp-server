import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, TOOLS_BY_NAME, buildSnippetUpdate } from "../src/tools.js";
import { validateToolArgs, ValidationError } from "../src/validate.js";
import { ChannelLock } from "../src/channel-lock.js";
import {
  ALLOWED_CHANNEL,
  ALLOWED_CHANNEL_RESPONSE,
  fakeYouTube,
  ownedVideo,
  resultJson,
  testConfig,
  testCtx,
} from "./helpers.js";

function ctxFor(youtube) {
  const config = testConfig({ YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL });
  return testCtx({
    config,
    youtube,
    channelLock: new ChannelLock({
      youtube,
      allowedChannelId: ALLOWED_CHANNEL,
      log: null,
    }),
  });
}

function wiredYouTube(video = ownedVideo()) {
  return fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": { items: [video] },
    "videos.update": { id: "vid123" },
  });
}

// -- merge semantics --------------------------------------------------------

test("merge preserves every unspecified writable field", () => {
  const snippet = buildSnippetUpdate(ownedVideo().snippet, { title: "New title" });

  assert.equal(snippet.title, "New title");
  assert.equal(snippet.description, "Original description");
  assert.deepEqual(snippet.tags, ["one", "two"]);
  assert.equal(snippet.categoryId, "22");
  assert.equal(snippet.defaultLanguage, "en");
  assert.equal(snippet.defaultAudioLanguage, "en");
});

test("merge drops read-only snippet fields", () => {
  const snippet = buildSnippetUpdate(ownedVideo().snippet, {});

  for (const field of [
    "channelId",
    "channelTitle",
    "publishedAt",
    "thumbnails",
    "liveBroadcastContent",
    "localized",
  ]) {
    assert.equal(snippet[field], undefined, `${field} must not be sent`);
  }
});

test('an empty description is a real change, not a falsy no-op', () => {
  const snippet = buildSnippetUpdate(ownedVideo().snippet, { description: "" });
  assert.equal(snippet.description, "");
});

test("an empty tags array clears tags", () => {
  const snippet = buildSnippetUpdate(ownedVideo().snippet, { tags: [] });
  assert.deepEqual(snippet.tags, []);
});

// -- request shape ----------------------------------------------------------

test("update_video sends only the snippet part", async () => {
  const youtube = wiredYouTube();

  await HANDLERS.update_video({ videoId: "vid123", title: "New" }, ctxFor(youtube));

  const update = youtube.callsTo("videos.update")[0];
  assert.deepEqual(update.params.part, ["snippet"]);
  // status is absent entirely: privacy and audience cannot be touched here.
  assert.equal(update.params.requestBody.status, undefined);
  assert.equal(update.params.requestBody.snippet.title, "New");
  assert.equal(update.params.requestBody.snippet.description, "Original description");
});

test("update_video reports which fields changed and which were preserved", async () => {
  const youtube = wiredYouTube();

  const result = await HANDLERS.update_video(
    { videoId: "vid123", description: "" },
    ctxFor(youtube)
  );
  const payload = resultJson(result);

  assert.deepEqual(payload.fieldsChanged, ["description"]);
  assert.ok(payload.fieldsPreserved.includes("title"));
  assert.equal(payload.privacyUnchanged, true);
});

test("update_video refuses when the fetched video has no title to send", async () => {
  const video = ownedVideo();
  delete video.snippet.title;

  await assert.rejects(
    () => HANDLERS.update_video({ videoId: "vid123" }, ctxFor(wiredYouTube(video))),
    /no title is available/
  );
});

test("update_video refuses when the fetched video has no categoryId", async () => {
  const video = ownedVideo();
  delete video.snippet.categoryId;

  await assert.rejects(
    () => HANDLERS.update_video({ videoId: "vid123" }, ctxFor(wiredYouTube(video))),
    /no categoryId is available/
  );
});

test("update_video verifies ownership before updating", async () => {
  const foreign = ownedVideo();
  foreign.snippet.channelId = "UCnotours0000000000000";
  const youtube = wiredYouTube(foreign);

  await assert.rejects(
    () => HANDLERS.update_video({ videoId: "vid123", title: "x" }, ctxFor(youtube)),
    /belongs to channel/
  );
  assert.equal(youtube.callsTo("videos.update").length, 0);
});

test("update_video disables retries on the mutating call", async () => {
  const youtube = wiredYouTube();

  await HANDLERS.update_video({ videoId: "vid123", title: "New" }, ctxFor(youtube));

  const update = youtube.callsTo("videos.update")[0];
  assert.equal(update.options.retry, false);
});

// -- privacy cannot be reached through this tool ----------------------------

test("privacyStatus is not in the update_video schema", () => {
  assert.equal(
    TOOLS_BY_NAME.update_video.inputSchema.properties.privacyStatus,
    undefined
  );
});

test("privacyStatus passed to update_video is rejected with a pointed message", () => {
  assert.throws(
    () => validateToolArgs("update_video", { videoId: "v", privacyStatus: "public" }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /cannot change privacy/);
      assert.match(error.message, /set_video_privacy/);
      return true;
    }
  );
});

test("privacyStatus is rejected even alongside otherwise valid arguments", () => {
  assert.throws(
    () =>
      validateToolArgs("update_video", {
        videoId: "v",
        title: "Fine",
        privacyStatus: "private",
      }),
    /cannot change privacy/
  );
});
