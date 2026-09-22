/**
 * Test helpers.
 *
 * Everything here is fake. No test reaches Google, reads the operator's .env,
 * or touches a token file outside a per-test temporary directory.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { ChannelLock } from "../src/channel-lock.js";

export const PROJECT_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

export const ALLOWED_CHANNEL = "UCallowedchannel00000000";
export const OTHER_CHANNEL = "UCsomeoneelse00000000000";

/** A temp dir that is cleaned up by the caller. */
export async function tempDir(prefix = "yt-mcp-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Build a config from an explicit env object. `loadConfig` is pure, so nothing
 * here can leak into or out of process.env.
 */
export function testConfig(env = {}, options = {}) {
  const tokenFile =
    env.YOUTUBE_TOKEN_FILE ?? path.join(os.tmpdir(), "yt-mcp-test-token.json");
  return loadConfig(
    {
      MCP_SKIP_DOTENV: "1",
      YOUTUBE_API_KEY: "test-api-key",
      ...env,
      YOUTUBE_TOKEN_FILE: tokenFile,
    },
    {
      homedir: path.join(os.tmpdir(), "yt-mcp-fake-home"),
      packageRoot: PROJECT_ROOT,
      ...options,
    }
  );
}

/**
 * A fake googleapis YouTube client that records every call.
 *
 * Each option is either a plain object (returned as `{data}`), an Error (thrown)
 * or a function `(params, options) => result`.
 */
export function fakeYouTube(responses = {}) {
  const calls = [];

  const wrap = (name) => async (params, options) => {
    calls.push({ name, params, options });
    const impl = responses[name];
    if (impl === undefined) return { data: {} };
    if (impl instanceof Error) throw impl;
    if (typeof impl === "function") {
      const result = await impl(params, options);
      return result instanceof Error ? Promise.reject(result) : result;
    }
    return { data: impl };
  };

  return {
    calls,
    callsTo(name) {
      return calls.filter((call) => call.name === name);
    },
    channels: { list: wrap("channels.list") },
    videos: { list: wrap("videos.list"), update: wrap("videos.update") },
    comments: { list: wrap("comments.list"), insert: wrap("comments.insert") },
    commentThreads: { list: wrap("commentThreads.list") },
    thumbnails: { set: wrap("thumbnails.set") },
    search: { list: wrap("search.list") },
  };
}

export function fakeAnalytics(responses = {}) {
  const calls = [];
  return {
    calls,
    reports: {
      async query(params) {
        calls.push({ name: "reports.query", params });
        const impl = responses["reports.query"];
        if (impl instanceof Error) throw impl;
        return { data: impl ?? { rows: [] } };
      },
    },
  };
}

/** A googleapis-shaped error, including the fields that must never be logged. */
export function googleError(message, { status = 403, code, secret } = {}) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  if (code !== undefined) error.code = code;
  error.response = {
    status,
    headers: { authorization: `Bearer ${secret ?? "ya29.super-secret-token"}` },
    data: { error: { message } },
  };
  error.config = {
    url: "https://www.googleapis.com/youtube/v3/videos",
    headers: { Authorization: `Bearer ${secret ?? "ya29.super-secret-token"}` },
  };
  return error;
}

/** A transient (no definitive answer) error. */
export function transientError(message = "socket hang up") {
  const error = new Error(message);
  error.code = "ECONNRESET";
  return error;
}

/** A minimal owned video resource. */
export function ownedVideo(overrides = {}) {
  return {
    id: "vid123",
    snippet: {
      channelId: ALLOWED_CHANNEL,
      channelTitle: "Allowed Channel",
      title: "Original title",
      description: "Original description",
      tags: ["one", "two"],
      categoryId: "22",
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
      publishedAt: "2024-01-01T00:00:00Z",
      thumbnails: { default: { url: "https://example.invalid/t.jpg" } },
      liveBroadcastContent: "none",
      localized: { title: "Original title", description: "Original description" },
      ...overrides.snippet,
    },
    status: {
      uploadStatus: "processed",
      privacyStatus: "unlisted",
      license: "youtube",
      embeddable: true,
      publicStatsViewable: true,
      madeForKids: false,
      selfDeclaredMadeForKids: false,
      ...overrides.status,
    },
  };
}

/** A ChannelLock wired to a fake client and already verified. */
export async function verifiedLock(youtube, options = {}) {
  const lock = new ChannelLock({
    youtube,
    allowedChannelId: options.allowedChannelId ?? ALLOWED_CHANNEL,
    log: null,
    now: options.now,
  });
  return lock;
}

/** The standard channels.list response for the allowed channel. */
export const ALLOWED_CHANNEL_RESPONSE = {
  items: [{ id: ALLOWED_CHANNEL, snippet: { title: "Allowed Channel" } }],
};

export const OTHER_CHANNEL_RESPONSE = {
  items: [{ id: OTHER_CHANNEL, snippet: { title: "Someone Else" } }],
};

/** Build a handler context. */
export function testCtx({
  config = testConfig(),
  youtube = fakeYouTube(),
  youtubeAnalytics = null,
  channelLock,
  credentials = null,
  startOAuth,
} = {}) {
  return {
    config,
    log: null,
    youtube,
    youtubeAnalytics,
    channelLock:
      channelLock === undefined
        ? new ChannelLock({
            youtube,
            allowedChannelId: config.allowedChannelId,
            log: null,
          })
        : channelLock,
    credentials,
    tokenStore: null,
    startOAuth,
  };
}

/** Extract the text payload of a tool result. */
export function resultText(result) {
  return result.content.map((part) => part.text).join("\n");
}

/** Parse a JSON tool result. */
export function resultJson(result) {
  return JSON.parse(resultText(result));
}

/** Minimal valid JPEG and PNG byte sequences. */
export const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x20),
]);

export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x20),
]);
