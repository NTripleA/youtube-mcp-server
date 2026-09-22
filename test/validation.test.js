import test from "node:test";
import assert from "node:assert/strict";

import { ValidationError, validateToolArgs } from "../src/validate.js";

test("valid arguments pass", () => {
  assert.deepEqual(validateToolArgs("search_videos", { query: "cats" }), {
    query: "cats",
  });
});

test("a missing required field is rejected", () => {
  assert.throws(
    () => validateToolArgs("search_videos", {}),
    /missing required field "query"/
  );
});

test("unknown fields are rejected rather than silently ignored", () => {
  // Silently dropping a field is how a caller ends up believing it changed
  // something it did not.
  assert.throws(
    () => validateToolArgs("search_videos", { query: "cats", limit: 5 }),
    /unknown field "limit"/
  );
  assert.throws(
    () => validateToolArgs("get_video_details", { videoId: "v", extra: true }),
    /unknown field "extra"/
  );
  assert.throws(
    () => validateToolArgs("set_thumbnail", { videoId: "v", imgUrl: "x" }),
    /unknown field "imgUrl"/
  );
});

test("wrong types are rejected", () => {
  assert.throws(
    () => validateToolArgs("search_videos", { query: 42 }),
    /must be string/
  );
  assert.throws(
    () => validateToolArgs("update_video", { videoId: "v", tags: "not-an-array" }),
    /must be array/
  );
});

test("out-of-range numbers are rejected", () => {
  assert.throws(
    () => validateToolArgs("search_videos", { query: "c", maxResults: 500 }),
    /must be <= 50/
  );
  assert.throws(
    () => validateToolArgs("list_comments", { videoId: "v", maxResults: 0 }),
    /must be >= 1/
  );
});

test("enum violations are rejected", () => {
  assert.throws(
    () => validateToolArgs("set_video_privacy", { videoId: "v", privacyStatus: "secret" }),
    /must be equal to one of the allowed values/
  );
  assert.throws(
    () =>
      validateToolArgs("set_video_privacy", {
        videoId: "v",
        privacyStatus: "private",
        scheduledPublish: "maybe",
      }),
    /must be equal to one of the allowed values/
  );
});

test("each allowed privacy value is accepted", () => {
  for (const value of ["private", "unlisted", "public"]) {
    assert.ok(validateToolArgs("set_video_privacy", { videoId: "v", privacyStatus: value }));
  }
});

test("empty strings are rejected where a value is required", () => {
  assert.throws(
    () => validateToolArgs("reply_to_comment", { parentId: "", text: "hi" }),
    /fewer than 1 characters|must NOT have fewer/
  );
  assert.throws(
    () => validateToolArgs("reply_to_comment", { parentId: "c", text: "" }),
    /fewer than 1 characters|must NOT have fewer/
  );
});

test("an empty description is allowed - clearing a field is legitimate", () => {
  assert.ok(validateToolArgs("update_video", { videoId: "v", description: "" }));
});

test("tools with no parameters accept an empty object or nothing at all", () => {
  assert.deepEqual(validateToolArgs("youtube_auth_status", {}), {});
  assert.deepEqual(validateToolArgs("youtube_auth_status", undefined), {});
});

test("a non-object argument payload is rejected", () => {
  assert.throws(() => validateToolArgs("search_videos", ["cats"]), /must be an object/);
});

test("an unknown tool name is rejected", () => {
  assert.throws(() => validateToolArgs("nope", {}), ValidationError);
});

test("set_thumbnail accepts either input shape at the schema level", () => {
  // The exactly-one rule is enforced in the handler, since JSON Schema oneOf
  // would complicate the published contract for little gain.
  assert.ok(validateToolArgs("set_thumbnail", { videoId: "v", imagePath: "a.jpg" }));
  assert.ok(
    validateToolArgs("set_thumbnail", { videoId: "v", imageUrl: "https://x/a.jpg" })
  );
});
