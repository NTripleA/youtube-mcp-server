import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, buildStatusUpdate } from "../src/tools.js";
import { validateToolArgs } from "../src/validate.js";
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
  return testCtx({
    config: testConfig({ YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL }),
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

// -- request shape ----------------------------------------------------------

test("set_video_privacy sends only the status part", async () => {
  const youtube = wiredYouTube();

  await HANDLERS.set_video_privacy(
    { videoId: "vid123", privacyStatus: "public" },
    ctxFor(youtube)
  );

  const update = youtube.callsTo("videos.update")[0];
  assert.deepEqual(update.params.part, ["status"]);
  // snippet is absent entirely: metadata cannot be touched here.
  assert.equal(update.params.requestBody.snippet, undefined);
  assert.equal(update.params.requestBody.status.privacyStatus, "public");
});

test("other writable status fields are carried forward verbatim", () => {
  const { status } = buildStatusUpdate(ownedVideo().status, {
    privacyStatus: "public",
  });

  assert.equal(status.license, "youtube");
  assert.equal(status.embeddable, true);
  assert.equal(status.publicStatsViewable, true);
});

test("read-only status fields are never echoed back", () => {
  const { status } = buildStatusUpdate(
    ownedVideo({ status: { uploadStatus: "processed", failureReason: "none" } }).status,
    { privacyStatus: "public" }
  );

  assert.equal(status.uploadStatus, undefined);
  assert.equal(status.failureReason, undefined);
  assert.equal(status.madeForKids, undefined);
});

test("privacyStatus is validated in the handler, not only the schema", () => {
  assert.throws(
    () => buildStatusUpdate(ownedVideo().status, { privacyStatus: "semi-public" }),
    /must be one of private, unlisted, public/
  );
});

test("the schema rejects an invalid privacy value too", () => {
  assert.throws(
    () => validateToolArgs("set_video_privacy", { videoId: "v", privacyStatus: "open" }),
    /Invalid arguments/
  );
});

test("set_video_privacy verifies ownership before updating", async () => {
  const foreign = ownedVideo();
  foreign.snippet.channelId = "UCnotours0000000000000";
  const youtube = wiredYouTube(foreign);

  await assert.rejects(
    () =>
      HANDLERS.set_video_privacy(
        { videoId: "vid123", privacyStatus: "private" },
        ctxFor(youtube)
      ),
    /belongs to channel/
  );
  assert.equal(youtube.callsTo("videos.update").length, 0);
});

// -- made-for-kids: preserve, never synthesize ------------------------------

test("an explicit owner declaration is preserved verbatim (false)", () => {
  const { status, notes } = buildStatusUpdate(
    ownedVideo({ status: { selfDeclaredMadeForKids: false, madeForKids: false } }).status,
    { privacyStatus: "public" }
  );

  assert.equal(status.selfDeclaredMadeForKids, false);
  assert.match(notes.join(" "), /Preserved the explicit owner declaration/);
});

test("an explicit owner declaration is preserved verbatim (true)", () => {
  const { status } = buildStatusUpdate(
    ownedVideo({ status: { selfDeclaredMadeForKids: true, madeForKids: true } }).status,
    { privacyStatus: "private" }
  );

  assert.equal(status.selfDeclaredMadeForKids, true);
});

test("an absent declaration is left unset, not synthesized from madeForKids", () => {
  // madeForKids is the EFFECTIVE designation and may come from a channel-level
  // setting. Promoting it would fabricate an owner declaration never made.
  const video = ownedVideo();
  delete video.status.selfDeclaredMadeForKids;
  video.status.madeForKids = true;

  const { status, notes } = buildStatusUpdate(video.status, {
    privacyStatus: "public",
  });

  assert.equal(
    Object.prototype.hasOwnProperty.call(status, "selfDeclaredMadeForKids"),
    false,
    "the key must be omitted entirely so unset stays unset"
  );
  assert.match(notes.join(" "), /No explicit video-level made-for-kids declaration/);
  // The effective value is reported so a channel-level designation is visible.
  assert.match(notes.join(" "), /Effective madeForKids=true/);
});

test("an absent declaration is not an error for an owner-authorized response", async () => {
  const video = ownedVideo();
  delete video.status.selfDeclaredMadeForKids;
  const youtube = wiredYouTube(video);

  const result = await HANDLERS.set_video_privacy(
    { videoId: "vid123", privacyStatus: "public" },
    ctxFor(youtube)
  );

  assert.equal(resultJson(result).updated, true);
  assert.equal(youtube.callsTo("videos.update").length, 1);
});

test("a missing status part is refused - preservation cannot be determined", () => {
  assert.throws(
    () => buildStatusUpdate(undefined, { privacyStatus: "public" }),
    /returned no status part/
  );
});

test("a status part without privacyStatus is refused as an untrustworthy shape", () => {
  assert.throws(
    () => buildStatusUpdate({ license: "youtube" }, { privacyStatus: "public" }),
    /missing privacyStatus/
  );
});

test("the refusal propagates through the handler without updating", async () => {
  const video = ownedVideo();
  delete video.status;
  const youtube = wiredYouTube(video);

  await assert.rejects(
    () =>
      HANDLERS.set_video_privacy(
        { videoId: "vid123", privacyStatus: "public" },
        ctxFor(youtube)
      ),
    /returned no status part/
  );
  assert.equal(youtube.callsTo("videos.update").length, 0);
});

// -- scheduled publication --------------------------------------------------

const SCHEDULED = "2030-06-01T10:00:00Z";
const PAST_SCHEDULE = "2020-06-01T10:00:00Z";

function scheduledVideo(publishAt = SCHEDULED) {
  return ownedVideo({ status: { privacyStatus: "private", publishAt } });
}

test("a scheduled video refuses a privacy change without an explicit decision", () => {
  assert.throws(
    () => buildStatusUpdate(scheduledVideo().status, { privacyStatus: "public" }),
    (error) => {
      assert.match(error.message, /scheduled to publish at/);
      assert.match(error.message, /scheduledPublish="preserve"/);
      assert.match(error.message, /scheduledPublish="cancel"/);
      return true;
    }
  );
});

test("preserve keeps the schedule when the target is private", () => {
  const { status, resultingSchedule, notes } = buildStatusUpdate(
    scheduledVideo().status,
    { privacyStatus: "private", scheduledPublish: "preserve" }
  );

  assert.equal(status.publishAt, SCHEDULED);
  assert.equal(resultingSchedule, SCHEDULED);
  assert.match(notes.join(" "), /Preserved the scheduled publish time/);
});

test("preserve combined with a non-private target is rejected as unsupported", () => {
  for (const target of ["public", "unlisted"]) {
    assert.throws(
      () =>
        buildStatusUpdate(scheduledVideo().status, {
          privacyStatus: target,
          scheduledPublish: "preserve",
        }),
      /Unsupported combination/,
      `target ${target} must be rejected`
    );
  }
});

test("cancel drops the schedule and says so explicitly", () => {
  const { status, resultingSchedule, notes } = buildStatusUpdate(
    scheduledVideo().status,
    { privacyStatus: "public", scheduledPublish: "cancel" }
  );

  assert.equal(status.publishAt, undefined);
  assert.equal(resultingSchedule, null);
  assert.match(notes.join(" "), /Cancelled the scheduled publish time/);
});

test("a preserved schedule in the past produces an explicit warning", () => {
  const { warnings, resultingSchedule } = buildStatusUpdate(
    scheduledVideo(PAST_SCHEDULE).status,
    { privacyStatus: "private", scheduledPublish: "preserve" },
    Date.parse("2026-01-01T00:00:00Z")
  );

  assert.equal(resultingSchedule, PAST_SCHEDULE);
  assert.match(warnings.join(" "), /is in the past/);
  assert.match(warnings.join(" "), /may publish this video immediately/);
});

test("a future preserved schedule produces no warning", () => {
  const { warnings } = buildStatusUpdate(
    scheduledVideo(SCHEDULED).status,
    { privacyStatus: "private", scheduledPublish: "preserve" },
    Date.parse("2026-01-01T00:00:00Z")
  );

  assert.deepEqual(warnings, []);
});

test("scheduledPublish on an unscheduled video is reported as a no-op", () => {
  const { notes, resultingSchedule } = buildStatusUpdate(ownedVideo().status, {
    privacyStatus: "public",
    scheduledPublish: "cancel",
  });

  assert.equal(resultingSchedule, null);
  assert.match(notes.join(" "), /no scheduled publish time/);
});

test("the handler reports resulting privacy and schedule", async () => {
  const youtube = wiredYouTube(scheduledVideo());

  const result = await HANDLERS.set_video_privacy(
    { videoId: "vid123", privacyStatus: "private", scheduledPublish: "preserve" },
    ctxFor(youtube)
  );
  const payload = resultJson(result);

  assert.equal(payload.previousPrivacy, "private");
  assert.equal(payload.resultingPrivacy, "private");
  assert.equal(payload.resultingScheduledPublish, SCHEDULED);
  assert.equal(payload.metadataUnchanged, true);
});

test("a scheduled video is not modified when the decision is missing", async () => {
  const youtube = wiredYouTube(scheduledVideo());

  await assert.rejects(
    () =>
      HANDLERS.set_video_privacy(
        { videoId: "vid123", privacyStatus: "public" },
        ctxFor(youtube)
      ),
    /scheduled to publish at/
  );
  assert.equal(youtube.callsTo("videos.update").length, 0);
});
