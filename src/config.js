/**
 * Configuration.
 *
 * `loadConfig` is deliberately PURE: it reads only the `env` object handed to
 * it, never `process.env` directly. That is what keeps the test-suite isolated
 * from the operator's real .env, home-directory token file and Google
 * credentials - tests construct their own env object and get a config that
 * cannot touch anything real.
 */

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { registerSecret } from "./logger.js";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 2 MiB - YouTube's documented custom-thumbnail limit. */
export const DEFAULT_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
/** The hard ceiling advertised by the thumbnails.set discovery document. */
export const ABSOLUTE_THUMBNAIL_MAX_BYTES = 52428800;
/** Cap on an inbound JSON-RPC request body in HTTP mode. */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

/**
 * Strict boolean parsing. Only "true" and "1" enable a flag; a typo such as
 * "yes", "on" or "ture" leaves it OFF. For a switch that gates channel writes,
 * failing closed on a typo is the only safe reading.
 */
export function parseStrictBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  return false;
}

function parseList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultTokenFile(env, homedir) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? xdg : path.join(homedir, ".config");
  return path.join(base, "youtube-mcp", "token.json");
}

/** True when `child` is inside `parent` (or is `parent`). */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * @param {Record<string,string|undefined>} env
 * @param {{argv?: string[], homedir?: string, packageRoot?: string}} [options]
 */
export function loadConfig(env = {}, options = {}) {
  const argv = options.argv ?? [];
  const homedir = options.homedir ?? os.homedir();
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;

  const transportRaw = argv.includes("--http")
    ? "http"
    : (env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();

  if (transportRaw !== "stdio" && transportRaw !== "http") {
    throw new Error(
      `MCP_TRANSPORT must be "stdio" or "http" (got "${transportRaw}")`
    );
  }
  const transport = transportRaw;
  const isRemote = transport === "http";

  // 0 is valid and means "bind an ephemeral port"; the transport reconciles the
  // Host allowlist with whatever port is actually bound.
  const port = Number(env.MCP_HTTP_PORT ?? 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MCP_HTTP_PORT must be a port number (got "${env.MCP_HTTP_PORT}")`);
  }

  // Loopback by default so a bare `MCP_TRANSPORT=http` run can never land on
  // the LAN by accident. Dockerfile.remote sets 0.0.0.0 explicitly, because
  // inside a container that is required - and the container's port is only
  // ever published to 127.0.0.1 on the host.
  const host = (env.MCP_HTTP_HOST ?? "127.0.0.1").trim();

  const mcpPath = (env.MCP_HTTP_PATH ?? "/mcp").trim();

  // The SDK compares the Host header exactly, including port. Always allow the
  // loopback forms; MCP_ALLOWED_HOSTS EXTENDS this list rather than replacing
  // it, so a misconfigured public hostname never locks out local diagnostics.
  const allowedHosts = [
    ...new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      ...parseList(env.MCP_ALLOWED_HOSTS),
    ]),
  ];

  // Empty list => the SDK performs no Origin check at all. A request that omits
  // Origin (normal for server-to-server clients) is never rejected either way;
  // only a PRESENT-but-unlisted Origin is refused.
  const allowedOrigins = parseList(env.MCP_ALLOWED_ORIGINS);

  const clientId = env.YOUTUBE_CLIENT_ID?.trim() || null;
  const clientSecret = env.YOUTUBE_CLIENT_SECRET?.trim() || null;
  const apiKey = env.YOUTUBE_API_KEY?.trim() || null;

  registerSecret(clientSecret);
  registerSecret(apiKey);

  const tokenFile = path.resolve(
    env.YOUTUBE_TOKEN_FILE?.trim() || defaultTokenFile(env, homedir)
  );

  // Tokens must never live in the Git checkout.
  if (isInside(packageRoot, tokenFile)) {
    throw new Error(
      "YOUTUBE_TOKEN_FILE resolves inside the project directory; OAuth tokens " +
        "must be stored outside the Git checkout (default: " +
        "~/.config/youtube-mcp/token.json)"
    );
  }

  const allowedChannelId = env.YOUTUBE_ALLOWED_CHANNEL_ID?.trim() || null;

  // Absent => OFF in remote mode (writes are an explicit opt-in there), ON in
  // stdio mode so an existing local workflow keeps working unchanged.
  const writesEnabled = parseStrictBoolean(env.YOUTUBE_ENABLE_WRITES, !isRemote);

  const mediaDirRaw = env.YOUTUBE_MEDIA_DIR?.trim();
  const mediaDir = mediaDirRaw
    ? path.resolve(mediaDirRaw)
    : isRemote
      ? "/media"
      : null;

  let thumbnailMaxBytes = Number(
    env.YOUTUBE_THUMBNAIL_MAX_BYTES ?? DEFAULT_THUMBNAIL_MAX_BYTES
  );
  if (!Number.isInteger(thumbnailMaxBytes) || thumbnailMaxBytes < 1) {
    thumbnailMaxBytes = DEFAULT_THUMBNAIL_MAX_BYTES;
  }
  thumbnailMaxBytes = Math.min(thumbnailMaxBytes, ABSOLUTE_THUMBNAIL_MAX_BYTES);

  const thumbnailUrlAllowedHosts = parseList(
    env.YOUTUBE_THUMBNAIL_URL_ALLOWED_HOSTS
  ).map((h) => h.toLowerCase());

  const config = {
    transport,
    isRemote,
    http: {
      host,
      port,
      path: mcpPath,
      allowedHosts,
      allowedOrigins,
      maxBodyBytes: MAX_HTTP_BODY_BYTES,
    },
    oauth: {
      clientId,
      clientSecret,
      configured: Boolean(clientId && clientSecret),
    },
    apiKey,
    tokenFile,
    allowedChannelId,
    writesEnabled,
    mediaDir,
    thumbnailMaxBytes,
    thumbnailUrlAllowedHosts,
    packageRoot,
  };

  return Object.freeze({
    ...config,
    http: Object.freeze(config.http),
    oauth: Object.freeze(config.oauth),
  });
}
