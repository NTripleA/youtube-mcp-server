import test from "node:test";
import assert from "node:assert/strict";

import { TOOL_DEFINITIONS, TOOLS_BY_NAME, ToolKind } from "../src/tools.js";

/**
 * The agreed classification. Annotations are hints - a client is free to ignore
 * them - so this table documents intent; the channel lock and the write gate
 * are what actually enforce anything.
 */
const EXPECTED = {
  search_videos: { readOnlyHint: true, openWorldHint: true },
  get_video_details: { readOnlyHint: true, openWorldHint: true },
  list_comments: { readOnlyHint: true, openWorldHint: true },
  analytics_top_videos: { readOnlyHint: true, openWorldHint: true },
  analytics_video_metrics: { readOnlyHint: true, openWorldHint: true },
  youtube_auth_status: { readOnlyHint: true, openWorldHint: true },
  reply_to_comment: {
    readOnlyHint: false,
    // Creates a reply; destroys nothing.
    destructiveHint: false,
    // A second call posts a second public reply.
    idempotentHint: false,
    openWorldHint: true,
  },
  update_video: {
    readOnlyHint: false,
    // Replaces existing metadata.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  set_thumbnail: {
    readOnlyHint: false,
    // Overwrites the previous custom thumbnail irrecoverably.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  set_video_privacy: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`${name} carries the agreed annotations`, () => {
    const tool = TOOLS_BY_NAME[name];
    assert.ok(tool, `${name} should exist`);

    for (const [hint, value] of Object.entries(expected)) {
      assert.equal(
        tool.annotations[hint],
        value,
        `${name}.${hint} should be ${value} but was ${tool.annotations[hint]}`
      );
    }
  });
}

test("every tool has a title and an annotations object", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.annotations, `${tool.name} has annotations`);
    assert.equal(typeof tool.annotations.title, "string", `${tool.name} has a title`);
    assert.equal(typeof tool.description, "string", `${tool.name} has a description`);
  }
});

test("read-kind tools are all marked readOnlyHint, and write-kind tools are not", () => {
  for (const tool of TOOL_DEFINITIONS) {
    if (tool.kind === ToolKind.READ) {
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    }
    if (tool.kind === ToolKind.WRITE) {
      assert.equal(tool.annotations.readOnlyHint, false, tool.name);
    }
  }
});

test("no read tool claims to be destructive", () => {
  for (const tool of TOOL_DEFINITIONS) {
    if (tool.kind !== ToolKind.READ) continue;
    assert.notEqual(tool.annotations.destructiveHint, true, tool.name);
  }
});

test("every schema forbids unknown properties", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name} must reject unknown fields`
    );
  }
});
