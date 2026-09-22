import test from "node:test";
import assert from "node:assert/strict";

import { ToolKind, visibleTools } from "../src/tools.js";
import { dispatchRefusal } from "../src/server.js";
import { parseStrictBoolean } from "../src/config.js";
import { TOOLS_BY_NAME } from "../src/tools.js";
import { ALLOWED_CHANNEL, testConfig } from "./helpers.js";

const WRITE_TOOLS = ["reply_to_comment", "update_video", "set_video_privacy", "set_thumbnail"];
const READ_TOOLS = [
  "search_videos",
  "get_video_details",
  "list_comments",
  "analytics_top_videos",
  "analytics_video_metrics",
  "youtube_auth_status",
];

const names = (config) => visibleTools(config).map((tool) => tool.name);

// -- defaults ---------------------------------------------------------------

test("HTTP mode defaults writes OFF when the switch is absent", () => {
  const config = testConfig({ MCP_TRANSPORT: "http" });
  assert.equal(config.writesEnabled, false);
});

test("stdio mode defaults writes ON so the existing local workflow is unchanged", () => {
  const config = testConfig({});
  assert.equal(config.writesEnabled, true);
});

test("an explicit value wins in either mode", () => {
  assert.equal(
    testConfig({ MCP_TRANSPORT: "http", YOUTUBE_ENABLE_WRITES: "true" }).writesEnabled,
    true
  );
  assert.equal(
    testConfig({ YOUTUBE_ENABLE_WRITES: "false" }).writesEnabled,
    false
  );
});

test("parsing is strict: anything but true/1 leaves the gate closed", () => {
  for (const enabling of ["true", "TRUE", " true ", "1"]) {
    assert.equal(parseStrictBoolean(enabling, false), true, enabling);
  }
  // A typo must fail closed rather than quietly enabling channel writes.
  for (const notEnabling of ["yes", "on", "ture", "TRUE!", "0", "false", "enabled"]) {
    assert.equal(parseStrictBoolean(notEnabling, true), false, notEnabling);
  }
  // Absent falls back to the mode default.
  assert.equal(parseStrictBoolean(undefined, true), true);
  assert.equal(parseStrictBoolean("", false), false);
});

// -- discovery --------------------------------------------------------------

test("write tools disappear from tools/list when the gate is closed", () => {
  const listed = names(testConfig({ MCP_TRANSPORT: "http" }));
  for (const tool of WRITE_TOOLS) {
    assert.equal(listed.includes(tool), false, `${tool} must be hidden`);
  }
});

test("read tools are never gated", () => {
  const listed = names(testConfig({ MCP_TRANSPORT: "http" }));
  for (const tool of READ_TOOLS) {
    assert.ok(listed.includes(tool), `${tool} must stay available`);
  }
});

test("write tools appear when the gate is open", () => {
  const listed = names(
    testConfig({
      MCP_TRANSPORT: "http",
      YOUTUBE_ENABLE_WRITES: "true",
      YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
    })
  );
  for (const tool of WRITE_TOOLS) {
    assert.ok(listed.includes(tool), `${tool} must be listed`);
  }
});

// -- dispatch (the actual enforcement) --------------------------------------

test("a hidden write tool is still refused at dispatch", () => {
  // A client holding a cached tool list can call a tool that is no longer
  // listed, so omission from tools/list cannot be the control.
  const config = testConfig({ MCP_TRANSPORT: "http" });

  for (const name of WRITE_TOOLS) {
    const refusal = dispatchRefusal(TOOLS_BY_NAME[name], config);
    assert.ok(refusal, `${name} must be refused`);
    assert.match(refusal, /YOUTUBE_ENABLE_WRITES/);
    assert.match(refusal, /No YouTube API call was made/);
  }
});

test("read tools are not refused at dispatch", () => {
  const config = testConfig({ MCP_TRANSPORT: "http" });
  for (const name of READ_TOOLS) {
    assert.equal(dispatchRefusal(TOOLS_BY_NAME[name], config), null, name);
  }
});

test("write tools pass dispatch when the gate is open", () => {
  const config = testConfig({
    MCP_TRANSPORT: "http",
    YOUTUBE_ENABLE_WRITES: "true",
    YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL,
  });
  for (const name of WRITE_TOOLS) {
    assert.equal(dispatchRefusal(TOOLS_BY_NAME[name], config), null, name);
  }
});

// -- local-only OAuth tools -------------------------------------------------

test("the OAuth tool is stdio-only in discovery", () => {
  assert.ok(names(testConfig({})).includes("youtube_start_oauth"));
  assert.equal(
    names(testConfig({ MCP_TRANSPORT: "http" })).includes("youtube_start_oauth"),
    false
  );
});

test("the OAuth tool is refused over HTTP even when the name is known", () => {
  const refusal = dispatchRefusal(
    TOOLS_BY_NAME.youtube_start_oauth,
    testConfig({ MCP_TRANSPORT: "http", YOUTUBE_ENABLE_WRITES: "true", YOUTUBE_ALLOWED_CHANNEL_ID: ALLOWED_CHANNEL })
  );
  assert.ok(refusal);
  assert.match(refusal, /unavailable over HTTP/);
  assert.match(refusal, /npm run auth/);
});

test("every tool is classified", () => {
  const kinds = new Set(Object.values(ToolKind));
  for (const tool of Object.values(TOOLS_BY_NAME)) {
    assert.ok(kinds.has(tool.kind), `${tool.name} has kind ${tool.kind}`);
  }
});

test("no delete-capable tool is exposed", () => {
  for (const name of Object.keys(TOOLS_BY_NAME)) {
    assert.doesNotMatch(name, /delete|remove|destroy/i);
  }
});
