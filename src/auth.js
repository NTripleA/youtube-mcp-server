/**
 * OAuth credentials and token persistence.
 *
 * The single most important behaviour here: Google returns `refresh_token` only
 * on the FIRST consent. Every subsequent refresh response omits it. Naively
 * writing a refresh response over the stored credentials therefore destroys the
 * refresh token and the deployment dies at the next access-token expiry.
 * `mergeCredentials` is what prevents that.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { google } from "googleapis";
import { sanitizeGoogleError } from "./logger.js";

/**
 * The minimum scope set for everything this server implements.
 *
 *  - youtube.force-ssl      required by comments.insert and commentThreads.list
 *                           (they accept NO other scope), and sufficient for
 *                           videos.update, thumbnails.set, videos.list,
 *                           channels.list and search.list.
 *  - youtube.readonly       the YouTube Analytics reference states reports.query
 *                           requests require it. Read-only by definition, so it
 *                           adds no write capability.
 *  - yt-analytics.readonly  required by youtubeAnalytics.reports.query.
 *
 * The broad https://www.googleapis.com/auth/youtube scope is deliberately NOT
 * requested: force-ssl already satisfies every implemented write method.
 */
export const SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
]);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Merge a credential update into stored credentials without ever losing a
 * working refresh token.
 *
 * @param {object|null} existing stored credentials, or null
 * @param {object} update        a token response from Google
 */
export function mergeCredentials(existing, update) {
  const base = existing && typeof existing === "object" ? existing : {};
  const incoming = update && typeof update === "object" ? update : {};
  const merged = { ...base, ...incoming };

  // Preserve when the update omits it; replace only when one is genuinely
  // supplied.
  if (!incoming.refresh_token && base.refresh_token) {
    merged.refresh_token = base.refresh_token;
  }

  // Drop keys explicitly set to undefined by the spread above.
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }

  return merged;
}

/**
 * Atomic, serialized, permission-preserving credential store.
 */
export class TokenStore {
  /** @param {string} filePath @param {{log?: object}} [options] */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.log = options.log ?? null;
    /** Serializes writes so two concurrent refreshes cannot interleave. */
    this._queue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        throw new Error(
          `Token file at ${this.filePath} is not valid JSON; re-run \`npm run auth\``
        );
      }
      throw error;
    }
  }

  async exists() {
    return (await this.load()) !== null;
  }

  /**
   * Merge `update` into the stored credentials and persist atomically.
   * Returns the merged credentials.
   */
  async save(update) {
    const run = async () => {
      const existing = await this.load();
      const merged = mergeCredentials(existing, update);
      await this._writeAtomic(merged);
      return merged;
    };

    // Chain onto the queue and keep the queue alive even if this write fails.
    const result = this._queue.then(run, run);
    this._queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async _writeAtomic(credentials) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    // mkdir's mode is subject to umask and is a no-op when the dir exists, so
    // assert it explicitly.
    await fs.chmod(dir, DIR_MODE).catch(() => {});

    const tmp = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto
        .randomBytes(6)
        .toString("hex")}.tmp`
    );

    let handle;
    try {
      handle = await fs.open(tmp, "wx", FILE_MODE);
      await handle.writeFile(JSON.stringify(credentials, null, 2), "utf8");
      await handle.sync().catch(() => {});
      await handle.close();
      handle = null;
      await fs.chmod(tmp, FILE_MODE);
      // rename within the same directory is atomic - this is why the STATE
      // DIRECTORY must be mounted in Docker, not token.json alone.
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }
}

/**
 * Build an OAuth2 client. `redirectUri` is supplied by the loopback auth
 * helper; the server itself never performs an authorization-code exchange.
 */
export function createOAuthClient(config, redirectUri) {
  if (!config.oauth.configured) return null;
  return new google.auth.OAuth2(
    config.oauth.clientId,
    config.oauth.clientSecret,
    redirectUri
  );
}

/**
 * Persist refreshed credentials for the life of the process.
 *
 * google-auth-library emits `tokens` on every refresh. The payload is secret,
 * so nothing about it beyond "a refresh happened" is ever logged.
 */
export function attachRefreshPersistence(oauth2Client, store, log) {
  oauth2Client.on("tokens", (tokens) => {
    store.save(tokens).then(
      () => log?.info("OAuth credentials refreshed and persisted"),
      (error) =>
        log?.error(
          `Failed to persist refreshed OAuth credentials: ${sanitizeGoogleError(error)}`
        )
    );
  });
  return oauth2Client;
}

/**
 * Scopes actually granted, read from the stored token. Returns `"unknown"` when
 * the token carries no `scope` field - the REQUESTED scope array is never
 * presented as evidence of a grant.
 */
export function grantedScopes(credentials) {
  const scope = credentials?.scope;
  if (typeof scope !== "string" || scope.trim() === "") return "unknown";
  return scope.trim().split(/\s+/);
}
