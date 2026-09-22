import test from "node:test";
import assert from "node:assert/strict";

import { BindingState, ChannelLock } from "../src/channel-lock.js";
import {
  ALLOWED_CHANNEL,
  ALLOWED_CHANNEL_RESPONSE,
  OTHER_CHANNEL,
  OTHER_CHANNEL_RESPONSE,
  fakeYouTube,
  googleError,
  ownedVideo,
  transientError,
} from "./helpers.js";

function lockFor(youtube, allowedChannelId = ALLOWED_CHANNEL, now) {
  return new ChannelLock({ youtube, allowedChannelId, log: null, now });
}

test("binding verifies when the authenticated channel matches", async () => {
  const youtube = fakeYouTube({ "channels.list": ALLOWED_CHANNEL_RESPONSE });
  const lock = lockFor(youtube);

  const binding = await lock.ensureBinding();

  assert.equal(binding.state, BindingState.VERIFIED);
  assert.equal(binding.channelId, ALLOWED_CHANNEL);
  assert.equal(binding.channelTitle, "Allowed Channel");
});

test("binding reports MISMATCH when a different channel is authenticated", async () => {
  const youtube = fakeYouTube({ "channels.list": OTHER_CHANNEL_RESPONSE });
  const lock = lockFor(youtube);

  const binding = await lock.ensureBinding();

  assert.equal(binding.state, BindingState.MISMATCH);
  assert.match(binding.reason, new RegExp(OTHER_CHANNEL));
  await assert.rejects(() => lock.assertWritable(), /Write blocked/);
});

test("an account with no channel is a definitive MISMATCH, not a transient failure", async () => {
  const youtube = fakeYouTube({ "channels.list": { items: [] } });
  const lock = lockFor(youtube);

  const binding = await lock.ensureBinding();

  assert.equal(binding.state, BindingState.MISMATCH);
  assert.match(binding.reason, /no YouTube channel/);
});

test("VERIFIED is cached: a second call makes no further API request", async () => {
  const youtube = fakeYouTube({ "channels.list": ALLOWED_CHANNEL_RESPONSE });
  const lock = lockFor(youtube);

  await lock.ensureBinding();
  await lock.ensureBinding();

  assert.equal(youtube.callsTo("channels.list").length, 1);
});

test("a transient failure yields UNVERIFIED and is never cached as success", async () => {
  const youtube = fakeYouTube({ "channels.list": transientError() });
  const lock = lockFor(youtube);

  const binding = await lock.ensureBinding();

  assert.equal(binding.state, BindingState.UNVERIFIED);
  assert.notEqual(lock.state, BindingState.VERIFIED);
});

test("UNVERIFIED blocks writes with a transient-flavoured error", async () => {
  const youtube = fakeYouTube({ "channels.list": transientError() });
  const lock = lockFor(youtube);

  await assert.rejects(
    () => lock.assertWritable(),
    (error) => {
      assert.equal(error.name, "BindingUnverifiedError");
      assert.equal(error.transient, true);
      assert.match(error.message, /Read-only tools are unaffected/);
      return true;
    }
  );
});

test("UNVERIFIED backs off rather than hammering a failing API", async () => {
  let clock = 1_000_000;
  const youtube = fakeYouTube({ "channels.list": transientError() });
  const lock = lockFor(youtube, ALLOWED_CHANNEL, () => clock);

  await lock.ensureBinding();
  await lock.ensureBinding(); // within the backoff window
  assert.equal(youtube.callsTo("channels.list").length, 1);

  clock += 11_000; // past the backoff window
  await lock.ensureBinding();
  assert.equal(youtube.callsTo("channels.list").length, 2);
});

test("recovery from UNVERIFIED unblocks writes", async () => {
  let clock = 1_000_000;
  let attempt = 0;
  const youtube = fakeYouTube({
    "channels.list": () => {
      attempt += 1;
      if (attempt === 1) throw transientError();
      return { data: ALLOWED_CHANNEL_RESPONSE };
    },
  });
  const lock = lockFor(youtube, ALLOWED_CHANNEL, () => clock);

  assert.equal((await lock.ensureBinding()).state, BindingState.UNVERIFIED);

  clock += 11_000;
  const binding = await lock.ensureBinding();

  assert.equal(binding.state, BindingState.VERIFIED);
  await lock.assertWritable(); // does not throw
});

test("a definitive auth failure is treated as MISMATCH, not a transient outage", async () => {
  const youtube = fakeYouTube({
    "channels.list": googleError("Invalid Credentials", { status: 401 }),
  });
  const lock = lockFor(youtube);

  const binding = await lock.ensureBinding();

  assert.equal(binding.state, BindingState.MISMATCH);
});

test("writes refuse outright when no allowed channel is configured", async () => {
  const youtube = fakeYouTube({ "channels.list": ALLOWED_CHANNEL_RESPONSE });
  const lock = lockFor(youtube, null);

  await assert.rejects(
    () => lock.assertWritable(),
    /YOUTUBE_ALLOWED_CHANNEL_ID is not set/
  );
  assert.equal(youtube.callsTo("channels.list").length, 0);
});

// -- per-target ownership ---------------------------------------------------

test("assertVideoOwned returns the fetched video for an owned video", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": { items: [ownedVideo()] },
  });
  const lock = lockFor(youtube);

  const video = await lock.assertVideoOwned("vid123");

  assert.equal(video.snippet.channelId, ALLOWED_CHANNEL);
  // One fetch serves both the ownership check and the later merge.
  assert.equal(youtube.callsTo("videos.list").length, 1);
});

test("a write is rejected for a video on a different channel", async () => {
  const foreign = ownedVideo();
  foreign.snippet.channelId = OTHER_CHANNEL;

  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": { items: [foreign] },
  });
  const lock = lockFor(youtube);

  await assert.rejects(
    () => lock.assertVideoOwned("vid123"),
    (error) => {
      assert.match(error.message, /belongs to channel/);
      assert.match(error.message, new RegExp(OTHER_CHANNEL));
      return true;
    }
  );
  assert.equal(youtube.callsTo("videos.update").length, 0);
});

test("a missing video is a refusal, not a pass", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": { items: [] },
  });
  const lock = lockFor(youtube);

  await assert.rejects(() => lock.assertVideoOwned("nope"), /was not found/);
});

test("a video with no channelId is a refusal", async () => {
  const video = ownedVideo();
  delete video.snippet.channelId;

  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": { items: [video] },
  });
  const lock = lockFor(youtube);

  await assert.rejects(() => lock.assertVideoOwned("vid123"), /no channelId/);
});

test("a transient failure during ownership lookup blocks the write", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "videos.list": transientError(),
  });
  const lock = lockFor(youtube);

  await assert.rejects(
    () => lock.assertVideoOwned("vid123"),
    (error) => {
      assert.equal(error.name, "BindingUnverifiedError");
      assert.match(error.message, /Nothing was modified/);
      return true;
    }
  );
});
