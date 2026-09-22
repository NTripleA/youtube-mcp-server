/**
 * Wiring: turn a config into a live context, then validate the deployment.
 *
 * Startup validation is where a misconfigured remote deployment is stopped,
 * but only for problems that are definitively wrong. A transient inability to
 * reach Google blocks writes without taking down read-only tools.
 */

import {
  TokenStore,
  attachRefreshPersistence,
  createOAuthClient,
} from "./auth.js";
import { BindingState, ChannelLock } from "./channel-lock.js";
import { buildGoogleClients } from "./tools.js";
import { runLoopbackOAuth } from "./oauth-flow.js";

/**
 * Build the shared context. In HTTP mode this is created once and shared by
 * every per-request Server instance.
 */
export async function createContext(config, { log } = {}) {
  const tokenStore = new TokenStore(config.tokenFile, { log });

  const ctx = {
    config,
    log,
    tokenStore,
    credentials: null,
    oauth2Client: null,
    youtube: null,
    youtubeAnalytics: null,
    channelLock: null,
  };

  await wireCredentials(ctx);

  // Interactive authorization is stdio-only. In remote mode the tool is both
  // hidden and refused at dispatch, so this is never reachable there.
  if (!config.isRemote) {
    ctx.startOAuth = async () => {
      const result = await runLoopbackOAuth({
        config,
        tokenStore,
        log,
        onAuthUrl: (url) => log?.info(`Open this URL to authorize:\n${url}`),
      });
      await wireCredentials(ctx);
      if (ctx.channelLock?.isConfigured) {
        await ctx.channelLock.ensureBinding({ force: true });
      }
      return result;
    };
  }

  return ctx;
}

/**
 * (Re)build the Google clients from whatever credentials are on disk.
 * Called at startup and again after a successful authorization.
 */
async function wireCredentials(ctx) {
  const { config, log } = ctx;

  let credentials = null;
  let oauth2Client = null;

  if (config.oauth.configured) {
    credentials = await ctx.tokenStore.load();
    if (credentials) {
      oauth2Client = createOAuthClient(config, null);
      oauth2Client.setCredentials(credentials);
      // Refreshed credentials must be merged back, never overwritten.
      attachRefreshPersistence(oauth2Client, ctx.tokenStore, log);
    }
  }

  const clients = buildGoogleClients({ oauth2Client, apiKey: config.apiKey });

  ctx.credentials = credentials;
  ctx.oauth2Client = oauth2Client;
  ctx.youtube = clients.youtube;
  ctx.youtubeAnalytics = clients.youtubeAnalytics;
  ctx.channelLock = oauth2Client
    ? new ChannelLock({
        youtube: clients.youtube,
        allowedChannelId: config.allowedChannelId,
        log,
      })
    : null;

  return ctx;
}

/**
 * Validate the deployment.
 *
 * @returns {Promise<{fatal: string|null, messages: string[]}>}
 */
export async function validateStartup(ctx) {
  const { config, log } = ctx;
  const messages = [];

  if (!config.apiKey && !config.oauth.configured) {
    return {
      fatal:
        "No credentials: set YOUTUBE_API_KEY for public reads, and/or " +
        "YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET for channel access.",
      messages,
    };
  }

  // The channel lock is mandatory for a remote deployment that can write. A
  // writes-disabled remote deployment is read-only, so it needs no lock and
  // boots without inventing a dummy value.
  if (config.isRemote && config.writesEnabled && !config.allowedChannelId) {
    return {
      fatal:
        "YOUTUBE_ALLOWED_CHANNEL_ID is required when YOUTUBE_ENABLE_WRITES is " +
        "enabled in HTTP mode. Set it to the channel this deployment may modify, " +
        "or disable writes.",
      messages,
    };
  }

  if (config.writesEnabled && !config.oauth.configured) {
    messages.push(
      "Writes are enabled but OAuth is not configured; every write will refuse."
    );
  } else if (config.writesEnabled && !ctx.credentials) {
    messages.push(
      `Writes are enabled but no token was found at ${config.tokenFile}; ` +
        "every write will refuse until credentials are provisioned."
    );
  }

  if (ctx.channelLock?.isConfigured) {
    const binding = await ctx.channelLock.ensureBinding();

    if (binding.state === BindingState.VERIFIED) {
      messages.push(
        `Channel lock verified: authenticated as ${binding.channelId}` +
          (binding.channelTitle ? ` (${binding.channelTitle})` : "")
      );
    } else if (binding.state === BindingState.MISMATCH) {
      const detail = `Channel lock FAILED: ${binding.reason}`;
      // A definitive mismatch on a remote deployment is fatal: the credentials
      // do not belong to the channel this deployment exists to manage.
      if (config.isRemote) return { fatal: detail, messages };
      messages.push(`${detail}. All writes are blocked.`);
    } else if (binding.state === BindingState.UNVERIFIED) {
      // Transient: block writes, keep serving reads, retry lazily.
      messages.push(
        `Channel lock could not be verified right now (${binding.reason}). ` +
          "Writes are blocked; read-only tools continue to serve and " +
          "verification is retried on the next write."
      );
    }
  } else if (config.allowedChannelId && !ctx.credentials) {
    messages.push(
      "YOUTUBE_ALLOWED_CHANNEL_ID is set but no OAuth token is available, so " +
        "the binding has not been verified."
    );
  }

  for (const message of messages) log?.warn(message);

  return { fatal: null, messages };
}
