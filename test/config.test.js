import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

import { isInside, loadConfig } from "../src/config.js";
import { PROJECT_ROOT, testConfig } from "./helpers.js";

const fakeHome = path.join(os.tmpdir(), "yt-mcp-fake-home");
const base = { homedir: fakeHome, packageRoot: PROJECT_ROOT };

test("the token file defaults under the user's config directory", () => {
  const config = loadConfig({}, base);
  assert.equal(
    config.tokenFile,
    path.join(fakeHome, ".config", "youtube-mcp", "token.json")
  );
});

test("XDG_CONFIG_HOME is honoured", () => {
  const config = loadConfig({ XDG_CONFIG_HOME: "/xdg" }, base);
  assert.equal(config.tokenFile, path.join("/xdg", "youtube-mcp", "token.json"));
});

test("YOUTUBE_TOKEN_FILE overrides the default and is made absolute", () => {
  const config = loadConfig({ YOUTUBE_TOKEN_FILE: "/state/token.json" }, base);
  assert.equal(config.tokenFile, "/state/token.json");
});

test("a token path inside the Git checkout is refused outright", () => {
  // The original server stored token.json next to index.js. That is exactly
  // what must never happen again.
  assert.throws(
    () =>
      loadConfig(
        { YOUTUBE_TOKEN_FILE: path.join(PROJECT_ROOT, "token.json") },
        base
      ),
    /must be stored outside the Git checkout/
  );
  assert.throws(
    () =>
      loadConfig(
        { YOUTUBE_TOKEN_FILE: path.join(PROJECT_ROOT, "state", "token.json") },
        base
      ),
    /must be stored outside the Git checkout/
  );
});

test("the default token path is never inside the checkout", () => {
  const config = loadConfig({}, base);
  assert.equal(isInside(PROJECT_ROOT, config.tokenFile), false);
});

test("loadConfig reads only the env object it is given", () => {
  // Nothing from the real process environment may leak in.
  process.env.__YT_MCP_LEAK_CANARY = "leaked";
  try {
    const config = loadConfig({ YOUTUBE_API_KEY: "explicit" }, base);
    assert.equal(config.apiKey, "explicit");
    assert.equal(config.allowedChannelId, null);
    assert.equal(config.oauth.clientId, null);
  } finally {
    delete process.env.__YT_MCP_LEAK_CANARY;
  }
});

// -- transport --------------------------------------------------------------

test("stdio is the default transport", () => {
  assert.equal(loadConfig({}, base).transport, "stdio");
});

test("--http selects the HTTP transport", () => {
  assert.equal(loadConfig({}, { ...base, argv: ["--http"] }).transport, "http");
});

test("an unrecognised transport is rejected", () => {
  assert.throws(() => loadConfig({ MCP_TRANSPORT: "websocket" }, base), /must be/);
});

test("HTTP binds to loopback unless told otherwise", () => {
  // A bare `MCP_TRANSPORT=http` run must never land on the LAN by accident.
  const config = loadConfig({ MCP_TRANSPORT: "http" }, base);
  assert.equal(config.http.host, "127.0.0.1");
  assert.equal(config.http.port, 8000);
  assert.equal(config.http.path, "/mcp");
});

test("the bind address and port are configurable", () => {
  const config = loadConfig(
    { MCP_TRANSPORT: "http", MCP_HTTP_HOST: "0.0.0.0", MCP_HTTP_PORT: "9001" },
    base
  );
  assert.equal(config.http.host, "0.0.0.0");
  assert.equal(config.http.port, 9001);
});

test("an invalid port is rejected", () => {
  assert.throws(() => loadConfig({ MCP_HTTP_PORT: "not-a-port" }, base), /port number/);
  assert.throws(() => loadConfig({ MCP_HTTP_PORT: "70000" }, base), /port number/);
});

// -- host/origin ------------------------------------------------------------

test("loopback hosts are always allowed and MCP_ALLOWED_HOSTS extends the list", () => {
  const config = loadConfig(
    {
      MCP_TRANSPORT: "http",
      MCP_HTTP_PORT: "8000",
      MCP_ALLOWED_HOSTS: "youtube.example.com, other.example.com",
    },
    base
  );

  // Extends, never replaces: a misconfigured public hostname must not lock out
  // local diagnostics.
  assert.ok(config.http.allowedHosts.includes("127.0.0.1:8000"));
  assert.ok(config.http.allowedHosts.includes("localhost:8000"));
  assert.ok(config.http.allowedHosts.includes("[::1]:8000"));
  assert.ok(config.http.allowedHosts.includes("youtube.example.com"));
  assert.ok(config.http.allowedHosts.includes("other.example.com"));
});

test("allowed origins default to empty, which disables the Origin check", () => {
  assert.deepEqual(loadConfig({ MCP_TRANSPORT: "http" }, base).http.allowedOrigins, []);
});

// -- thumbnails -------------------------------------------------------------

test("the thumbnail size cap defaults to 2 MiB and is bounded by the API maximum", () => {
  assert.equal(loadConfig({}, base).thumbnailMaxBytes, 2 * 1024 * 1024);
  assert.equal(
    loadConfig({ YOUTUBE_THUMBNAIL_MAX_BYTES: "999999999" }, base).thumbnailMaxBytes,
    52428800
  );
  assert.equal(
    loadConfig({ YOUTUBE_THUMBNAIL_MAX_BYTES: "nonsense" }, base).thumbnailMaxBytes,
    2 * 1024 * 1024
  );
});

test("the thumbnail host allowlist is lowercased", () => {
  const config = loadConfig(
    { YOUTUBE_THUMBNAIL_URL_ALLOWED_HOSTS: "CDN.Example.COM" },
    base
  );
  assert.deepEqual(config.thumbnailUrlAllowedHosts, ["cdn.example.com"]);
});

// -- misc -------------------------------------------------------------------

test("the config object is frozen", () => {
  const config = testConfig({});
  assert.throws(() => {
    config.writesEnabled = true;
  }, TypeError);
});

test("isInside distinguishes a real child from a prefix sibling", () => {
  assert.equal(isInside("/a/media", "/a/media/x.jpg"), true);
  assert.equal(isInside("/a/media", "/a/media"), true);
  assert.equal(isInside("/a/media", "/a/media-evil/x.jpg"), false);
  assert.equal(isInside("/a/media", "/a/other/x.jpg"), false);
});
