import test from "node:test";
import assert from "node:assert/strict";

import { ChannelLock } from "../src/channel-lock.js";
import { HANDLERS } from "../src/tools.js";
import {
  ALLOWED_CHANNEL,
  ALLOWED_CHANNEL_RESPONSE,
  OTHER_CHANNEL,
  fakeYouTube,
  ownedVideo,
  resultJson,
  testConfig,
  testCtx,
  transientError,
} from "./helpers.js";

const TOP_LEVEL_ID = "UgxTopLevelCommentId";
const THREAD_ID = "UgxThreadIdThatIsDifferent";
const REPLY_ID = "UgxTopLevelCommentId.ReplyPart";

function lockFor(youtube) {
  return new ChannelLock({
    youtube,
    allowedChannelId: ALLOWED_CHANNEL,
    log: null,
  });
}

test("a top-level comment carrying videoId resolves without a thread lookup", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": {
      items: [{ id: TOP_LEVEL_ID, snippet: { videoId: "vid123" } }],
    },
    "videos.list": { items: [ownedVideo()] },
  });

  const target = await lockFor(youtube).resolveReplyTarget(TOP_LEVEL_ID);

  assert.equal(target.topLevelCommentId, TOP_LEVEL_ID);
  assert.equal(target.videoId, "vid123");
  assert.equal(target.inputWasReply, false);
  assert.equal(youtube.callsTo("commentThreads.list").length, 0);
});

test("replying to a reply targets the verified top-level parent, not the input", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": {
      items: [
        {
          id: REPLY_ID,
          // parentId comes from the API, so the real insert target is known
          // rather than inferred from the shape of the ID string.
          snippet: { videoId: "vid123", parentId: TOP_LEVEL_ID },
        },
      ],
    },
    "videos.list": { items: [ownedVideo()] },
  });

  const target = await lockFor(youtube).resolveReplyTarget(REPLY_ID);

  assert.equal(target.topLevelCommentId, TOP_LEVEL_ID);
  assert.equal(target.inputWasReply, true);
});

test("thread ID is never assumed equal to the top-level comment ID", async () => {
  // The thread's own ID differs from the top-level comment it contains. Our
  // lookup keys on the comment ID and then CHECKS the returned relationship,
  // so a thread that does not actually contain this comment is refused.
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": { items: [{ id: TOP_LEVEL_ID, snippet: {} }] },
    "commentThreads.list": {
      items: [
        {
          id: THREAD_ID,
          snippet: {
            videoId: "vid123",
            topLevelComment: { id: "SomeOtherCommentEntirely" },
          },
        },
      ],
    },
    "videos.list": { items: [ownedVideo()] },
  });

  await assert.rejects(
    () => lockFor(youtube).resolveReplyTarget(TOP_LEVEL_ID),
    /could not be confirmed/
  );
  assert.equal(youtube.callsTo("videos.list").length, 0);
});

test("a thread that does confirm the relationship supplies the videoId", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": { items: [{ id: TOP_LEVEL_ID, snippet: {} }] },
    "commentThreads.list": {
      items: [
        {
          id: THREAD_ID,
          snippet: {
            videoId: "vid123",
            topLevelComment: { id: TOP_LEVEL_ID },
          },
        },
      ],
    },
    "videos.list": { items: [ownedVideo()] },
  });

  const target = await lockFor(youtube).resolveReplyTarget(TOP_LEVEL_ID);

  assert.equal(target.videoId, "vid123");
  assert.equal(target.topLevelCommentId, TOP_LEVEL_ID);
});

test("ownership is checked on the video's channel, not the comment author's", async () => {
  // A viewer from another channel commented on OUR video. That must stay
  // replyable - the check is on the video, never on who wrote the comment.
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": {
      items: [
        {
          id: TOP_LEVEL_ID,
          snippet: {
            videoId: "vid123",
            authorChannelId: { value: OTHER_CHANNEL },
            channelId: OTHER_CHANNEL,
          },
        },
      ],
    },
    "videos.list": { items: [ownedVideo()] },
    "comments.insert": { id: "reply-1" },
  });

  const ctx = testCtx({
    config: testConfig({ YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL }),
    youtube,
    channelLock: lockFor(youtube),
  });

  const result = await HANDLERS.reply_to_comment(
    { parentId: TOP_LEVEL_ID, text: "thanks for watching" },
    ctx
  );

  assert.equal(resultJson(result).posted, true);
});

test("comments.insert uses the verified parent ID", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": {
      items: [{ id: REPLY_ID, snippet: { videoId: "vid123", parentId: TOP_LEVEL_ID } }],
    },
    "videos.list": { items: [ownedVideo()] },
    "comments.insert": { id: "reply-2" },
  });

  const ctx = testCtx({
    config: testConfig({ YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL }),
    youtube,
    channelLock: lockFor(youtube),
  });

  await HANDLERS.reply_to_comment({ parentId: REPLY_ID, text: "hi" }, ctx);

  const insert = youtube.callsTo("comments.insert")[0];
  assert.equal(insert.params.requestBody.snippet.parentId, TOP_LEVEL_ID);
  assert.notEqual(insert.params.requestBody.snippet.parentId, REPLY_ID);
});

test("mutating calls are sent with retries disabled", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": { items: [{ id: TOP_LEVEL_ID, snippet: { videoId: "vid123" } }] },
    "videos.list": { items: [ownedVideo()] },
    "comments.insert": { id: "reply-3" },
  });

  const ctx = testCtx({
    config: testConfig({ YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL }),
    youtube,
    channelLock: lockFor(youtube),
  });

  await HANDLERS.reply_to_comment({ parentId: TOP_LEVEL_ID, text: "hi" }, ctx);

  const insert = youtube.callsTo("comments.insert")[0];
  assert.equal(insert.options.retry, false);
  assert.equal(insert.options.retryConfig.retry, 0);
  assert.equal(insert.options.retryConfig.noResponseRetries, 0);
});

test("an ambiguous insert failure warns that it may already have posted", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": { items: [{ id: TOP_LEVEL_ID, snippet: { videoId: "vid123" } }] },
    "videos.list": { items: [ownedVideo()] },
    "comments.insert": transientError("socket hang up"),
  });

  const ctx = testCtx({
    config: testConfig({ YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL }),
    youtube,
    channelLock: lockFor(youtube),
  });

  await assert.rejects(
    () => HANDLERS.reply_to_comment({ parentId: TOP_LEVEL_ID, text: "hi" }, ctx),
    (error) => {
      assert.match(error.message, /MAY ALREADY HAVE BEEN POSTED/);
      assert.match(error.message, /not retried automatically/);
      return true;
    }
  );
  // Exactly one attempt: no automatic retry of an ambiguous mutation.
  assert.equal(youtube.callsTo("comments.insert").length, 1);
});

test("an unknown comment fails closed without posting", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": { items: [] },
  });

  await assert.rejects(
    () => lockFor(youtube).resolveReplyTarget("does-not-exist"),
    /was not found/
  );
  assert.equal(youtube.callsTo("comments.insert").length, 0);
});

test("a comment with no resolvable video fails closed", async () => {
  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": { items: [{ id: TOP_LEVEL_ID, snippet: {} }] },
    "commentThreads.list": {
      items: [
        { id: THREAD_ID, snippet: { topLevelComment: { id: TOP_LEVEL_ID } } },
      ],
    },
  });

  await assert.rejects(
    () => lockFor(youtube).resolveReplyTarget(TOP_LEVEL_ID),
    /not associated with a video/
  );
});

test("a comment on a foreign channel's video is refused", async () => {
  const foreign = ownedVideo();
  foreign.snippet.channelId = OTHER_CHANNEL;

  const youtube = fakeYouTube({
    "channels.list": ALLOWED_CHANNEL_RESPONSE,
    "comments.list": { items: [{ id: TOP_LEVEL_ID, snippet: { videoId: "other" } }] },
    "videos.list": { items: [foreign] },
  });

  await assert.rejects(
    () => lockFor(youtube).resolveReplyTarget(TOP_LEVEL_ID),
    /belongs to channel/
  );
});
