/**
 * Loaded via `node --test --import ./scripts/test-setup.js` before any test module.
 *
 * Guarantees isolation from the operator's real environment rather than relying
 * on each test happening not to read it: dotenv is disabled, and every real
 * credential variable is scrubbed from the process environment. A test that
 * needs configuration builds it explicitly with `loadConfig(env)`.
 */

process.env.MCP_SKIP_DOTENV = "1";

const SENSITIVE_VARS = [
  "YOUTUBE_API_KEY",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_TOKEN_FILE",
  "YOUTUBE_ALLOWED_CHANNEL_ID",
  "YOUTUBE_ENABLE_WRITES",
  "YOUTUBE_MEDIA_DIR",
  "YOUTUBE_THUMBNAIL_MAX_BYTES",
  "YOUTUBE_THUMBNAIL_URL_ALLOWED_HOSTS",
  "MCP_TRANSPORT",
  "MCP_HTTP_HOST",
  "MCP_HTTP_PORT",
  "MCP_ALLOWED_HOSTS",
  "MCP_ALLOWED_ORIGINS",
];

for (const name of SENSITIVE_VARS) {
  delete process.env[name];
}
