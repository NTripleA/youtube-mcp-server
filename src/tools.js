/**
 * Tool definitions and handlers.
 *
 * One implementation serves both transports. Every definition carries the JSON
 * Schema that is published in tools/list AND used for server-side validation,
 * so the contract and the enforcement cannot drift apart.
 *
 * Annotations are HINTS. They help a client present a tool sensibly; they are
 * not the security mechanism. The channel lock and the write gate are.
 */

import { Readable } from "node:stream";
import { google } from "googleapis";
import { grantedScopes, SCOPES } from "./auth.js";
import { BindingState } from "./channel-lock.js";
import { fetchThumbnailUrl, resolveThumbnailPath, MediaError } from "./media.js";
import { isTransientError, sanitizeGoogleError } from "./logger.js";

/** Tool kinds. `local` tools are stdio-only and rejected over HTTP. */
export const ToolKind = Object.freeze({
  READ: "read",
  WRITE: "write",
  LOCAL: "local",
});

/** Never auto-retry a mutating call: an ambiguous failure may have succeeded. */
const NO_RETRY = Object.freeze({
  retry: false,
  retryConfig: { retry: 0, noResponseRetries: 0 },
});

/** snippet fields videos.update actually accepts. Everything else is read-only. */
export const WRITABLE_SNIPPET_FIELDS = Object.freeze([
  "title",
  "description",
  "tags",
  "categoryId",
  "defaultLanguage",
  "defaultAudioLanguage",
]);

/** status fields carried forward verbatim by set_video_privacy. */
export const CARRIED_STATUS_FIELDS = Object.freeze([
  "license",
  "embeddable",
  "publicStatsViewable",
  "containsSyntheticMedia",
]);

export const PRIVACY_VALUES = Object.freeze(["private", "unlisted", "public"]);

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "search_videos",
    kind: ToolKind.READ,
    description: "Search YouTube for videos.",
    annotations: {
      title: "Search videos",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        maxResults: { type: "number", minimum: 1, maximum: 50 },
        pageToken: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_video_details",
    kind: ToolKind.READ,
    description: "Get snippet, statistics and status for a specific video.",
    annotations: {
      title: "Get video details",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { videoId: { type: "string", minLength: 1 } },
      required: ["videoId"],
    },
  },
  {
    name: "list_comments",
    kind: ToolKind.READ,
    description: "List comment threads on a video.",
    annotations: {
      title: "List comments",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        videoId: { type: "string", minLength: 1 },
        maxResults: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["videoId"],
    },
  },
  {
    name: "analytics_top_videos",
    kind: ToolKind.READ,
    description:
      "(Read-only) Top videos by metric over a date range, for the authenticated channel.",
    annotations: {
      title: "Analytics: top videos",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startDate: { type: "string", description: "YYYY-MM-DD" },
        endDate: { type: "string", description: "YYYY-MM-DD" },
        metric: {
          type: "string",
          enum: [
            "views",
            "estimatedMinutesWatched",
            "averageViewDuration",
            "subscribersGained",
          ],
        },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "analytics_video_metrics",
    kind: ToolKind.READ,
    description:
      "(Read-only) Metrics for one video over a date range, for the authenticated channel.",
    annotations: {
      title: "Analytics: video metrics",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        videoId: { type: "string", minLength: 1 },
        startDate: { type: "string", description: "YYYY-MM-DD" },
        endDate: { type: "string", description: "YYYY-MM-DD" },
        metrics: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["videoId", "startDate", "endDate"],
    },
  },
  {
    name: "youtube_auth_status",
    kind: ToolKind.READ,
    description:
      "Diagnostics: whether OAuth is configured, which channel is authenticated, " +
      "the allowed channel, whether they match, and whether writes are enabled. " +
      "Never returns tokens or secrets.",
    annotations: {
      title: "Auth status",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "youtube_start_oauth",
    kind: ToolKind.LOCAL,
    description:
      "Local-only. Run the Google Desktop OAuth loopback flow (PKCE) and store " +
      "the resulting refresh token. Unavailable over HTTP.",
    annotations: {
      title: "Start OAuth (local only)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "reply_to_comment",
    kind: ToolKind.WRITE,
    description:
      "Reply to a comment on a video owned by the allowed channel. The target " +
      "comment's video is verified before anything is posted.",
    annotations: {
      title: "Reply to comment",
      readOnlyHint: false,
      // Creates a new reply; destroys nothing.
      destructiveHint: false,
      // Calling twice posts two public replies.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
      },
      required: ["parentId", "text"],
    },
  },
  {
    name: "update_video",
    kind: ToolKind.WRITE,
    description:
      "Update a video's title, description or tags. Fetches current state and " +
      "merges, preserving unspecified fields. Cannot change privacy - use " +
      "set_video_privacy for that.",
    annotations: {
      title: "Update video metadata",
      readOnlyHint: false,
      // Replaces existing metadata; the previous values are not recoverable here.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        videoId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1, maxLength: 100 },
        description: { type: "string", maxLength: 5000 },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["videoId"],
    },
  },
  {
    name: "set_video_privacy",
    kind: ToolKind.WRITE,
    description:
      "Change a video's privacy status (private/unlisted/public) without touching " +
      "its metadata. If the video has a scheduled publish time, scheduledPublish " +
      "must be supplied explicitly.",
    annotations: {
      title: "Set video privacy",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        videoId: { type: "string", minLength: 1 },
        privacyStatus: { type: "string", enum: [...PRIVACY_VALUES] },
        scheduledPublish: {
          type: "string",
          enum: ["preserve", "cancel"],
          description:
            "Required when the video already has a scheduled publish time.",
        },
      },
      required: ["videoId", "privacyStatus"],
    },
  },
  {
    name: "set_thumbnail",
    kind: ToolKind.WRITE,
    description:
      "Set a custom thumbnail from a file inside the configured media directory " +
      "(imagePath) or a public HTTPS image (imageUrl). Exactly one of the two.",
    annotations: {
      title: "Set thumbnail",
      readOnlyHint: false,
      // Overwrites the existing custom thumbnail with no version history; the
      // previous image is not recoverable through the API.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        videoId: { type: "string", minLength: 1 },
        imagePath: { type: "string", minLength: 1 },
        imageUrl: { type: "string", minLength: 1 },
      },
      required: ["videoId"],
    },
  },
]);

export const TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]))
);

/**
 * The tools a given configuration should expose.
 *
 * Write tools disappear when the gate is closed, and local OAuth tools
 * disappear over HTTP. Both are ALSO enforced at dispatch - this filter is for
 * discovery, not for security.
 */
export function visibleTools(config) {
  return TOOL_DEFINITIONS.filter((tool) => {
    if (tool.kind === ToolKind.WRITE && !config.writesEnabled) return false;
    if (tool.kind === ToolKind.LOCAL && config.isRemote) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Pure merge helpers (exercised directly by the tests)
// ---------------------------------------------------------------------------

/**
 * Build the snippet body for videos.update.
 *
 * Starts from the CURRENT snippet restricted to writable fields, then applies
 * only the keys the caller actually supplied. `description: ""` is a real
 * change, so presence is tested with `!== undefined` rather than truthiness.
 */
export function buildSnippetUpdate(currentSnippet, args) {
  const merged = {};

  for (const field of WRITABLE_SNIPPET_FIELDS) {
    const value = currentSnippet?.[field];
    if (value !== undefined && value !== null) merged[field] = value;
  }

  for (const field of ["title", "description", "tags"]) {
    if (args[field] !== undefined) merged[field] = args[field];
  }

  return merged;
}

export class PrivacyPreservationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrivacyPreservationError";
  }
}

/**
 * Build the status body for set_video_privacy.
 *
 * Only ever called after ownership has been verified with the OAuth client, so
 * the response IS owner-authorized. That is what makes an absent
 * `selfDeclaredMadeForKids` interpretable rather than unknown.
 *
 * @returns {{status: object, notes: string[], warnings: string[],
 *            resultingSchedule: string|null}}
 */
export function buildStatusUpdate(currentStatus, { privacyStatus, scheduledPublish }, now = Date.now()) {
  if (!currentStatus || typeof currentStatus !== "object") {
    throw new PrivacyPreservationError(
      "Refusing to change privacy: the video returned no status part, so the " +
        "existing settings could not be safely preserved."
    );
  }
  if (typeof currentStatus.privacyStatus !== "string") {
    throw new PrivacyPreservationError(
      "Refusing to change privacy: the video's status part is missing " +
        "privacyStatus, so the response shape cannot be trusted for preservation."
    );
  }
  if (!PRIVACY_VALUES.includes(privacyStatus)) {
    throw new PrivacyPreservationError(
      `privacyStatus must be one of ${PRIVACY_VALUES.join(", ")} (got "${privacyStatus}")`
    );
  }

  const status = {};
  const notes = [];
  const warnings = [];

  for (const field of CARRIED_STATUS_FIELDS) {
    const value = currentStatus[field];
    if (value !== undefined && value !== null) status[field] = value;
  }

  status.privacyStatus = privacyStatus;

  // Audience declaration ---------------------------------------------------
  // Never synthesized from madeForKids: that is the EFFECTIVE designation and
  // may come from a channel-level setting. Promoting it would fabricate an
  // owner declaration that was never made.
  if (typeof currentStatus.selfDeclaredMadeForKids === "boolean") {
    status.selfDeclaredMadeForKids = currentStatus.selfDeclaredMadeForKids;
    notes.push(
      `Preserved the explicit owner declaration selfDeclaredMadeForKids=${currentStatus.selfDeclaredMadeForKids}.`
    );
  } else {
    // Owner-authorized response with a usable status part and no declaration =>
    // no explicit video-level declaration exists. Omit the key so unset stays
    // unset. This is not an error.
    notes.push(
      "No explicit video-level made-for-kids declaration exists; left unset. " +
        `Effective madeForKids=${
          currentStatus.madeForKids === undefined
            ? "unreported"
            : String(currentStatus.madeForKids)
        }.`
    );
  }

  // Scheduled publication --------------------------------------------------
  const existingSchedule = currentStatus.publishAt ?? null;
  let resultingSchedule = null;

  if (existingSchedule) {
    if (!scheduledPublish) {
      throw new PrivacyPreservationError(
        `Refusing to change privacy: video is scheduled to publish at ` +
          `${existingSchedule}. Pass scheduledPublish="preserve" to keep that ` +
          `schedule (only valid with privacyStatus="private") or ` +
          `scheduledPublish="cancel" to drop it.`
      );
    }

    if (scheduledPublish === "preserve") {
      if (privacyStatus !== "private") {
        throw new PrivacyPreservationError(
          `Unsupported combination: a scheduled publish time can only exist ` +
            `while the video is private, so scheduledPublish="preserve" cannot ` +
            `be combined with privacyStatus="${privacyStatus}". Use ` +
            `scheduledPublish="cancel" to publish now, or keep the video private.`
        );
      }
      status.publishAt = existingSchedule;
      resultingSchedule = existingSchedule;
      notes.push(`Preserved the scheduled publish time ${existingSchedule}.`);

      const scheduledAt = Date.parse(existingSchedule);
      if (Number.isFinite(scheduledAt) && scheduledAt <= now) {
        warnings.push(
          `The preserved publish time ${existingSchedule} is in the past; ` +
            "YouTube may publish this video immediately."
        );
      }
    } else {
      notes.push(
        `Cancelled the scheduled publish time ${existingSchedule} as requested.`
      );
    }
  } else if (scheduledPublish) {
    notes.push(
      `The video has no scheduled publish time, so scheduledPublish="${scheduledPublish}" had no effect.`
    );
  }

  return { status, notes, warnings, resultingSchedule };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function requireYouTube(ctx) {
  if (!ctx.youtube) {
    throw new Error(
      "YouTube API is not configured. Set YOUTUBE_API_KEY for public reads, or " +
        "YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET plus a token for authenticated access."
    );
  }
  return ctx.youtube;
}

function requireAnalytics(ctx) {
  if (!ctx.youtubeAnalytics) {
    throw new Error(
      "YouTube Analytics is not available: it requires OAuth credentials and a " +
        "stored token. Run `npm run auth` on the machine that holds the client secret."
    );
  }
  return ctx.youtubeAnalytics;
}

function requireChannelLock(ctx) {
  if (!ctx.channelLock) {
    throw new Error(
      "Write blocked: OAuth is not configured, so no channel can be verified."
    );
  }
  return ctx.channelLock;
}

export const HANDLERS = Object.freeze({
  async search_videos(args, ctx) {
    const youtube = requireYouTube(ctx);
    const response = await youtube.search.list({
      part: ["snippet"],
      q: args.query,
      maxResults: args.maxResults ?? 10,
      type: ["video"],
      pageToken: args.pageToken,
    });
    return text(response.data);
  },

  async get_video_details(args, ctx) {
    const youtube = requireYouTube(ctx);
    const response = await youtube.videos.list({
      part: ["snippet", "statistics", "status"],
      id: [args.videoId],
    });
    const video = response.data?.items?.[0];
    if (!video) throw new Error(`Video ${args.videoId} not found`);
    return text(video);
  },

  async list_comments(args, ctx) {
    const youtube = requireYouTube(ctx);
    const response = await youtube.commentThreads.list({
      part: ["snippet", "replies"],
      videoId: args.videoId,
      maxResults: args.maxResults ?? 20,
    });
    return text(response.data?.items ?? []);
  },

  async analytics_top_videos(args, ctx) {
    const analytics = requireAnalytics(ctx);
    const metric = args.metric ?? "views";
    const response = await analytics.reports.query({
      ids: "channel==MINE",
      startDate: args.startDate,
      endDate: args.endDate,
      metrics: metric,
      dimensions: "video",
      sort: `-${metric}`,
      maxResults: Math.min(Math.max(args.limit ?? 10, 1), 200),
    });
    return text(response.data);
  },

  async analytics_video_metrics(args, ctx) {
    const analytics = requireAnalytics(ctx);
    const metrics = args.metrics?.length
      ? args.metrics
      : ["views", "estimatedMinutesWatched", "averageViewDuration", "subscribersGained"];
    const response = await analytics.reports.query({
      ids: "channel==MINE",
      startDate: args.startDate,
      endDate: args.endDate,
      metrics: metrics.join(","),
      filters: `video==${args.videoId}`,
    });
    return text(response.data);
  },

  async youtube_auth_status(_args, ctx) {
    const { config } = ctx;
    const credentials = ctx.credentials ?? null;

    let binding = null;
    if (ctx.channelLock?.isConfigured && ctx.credentials) {
      binding = await ctx.channelLock.ensureBinding();
    } else if (ctx.channelLock) {
      binding = { state: ctx.channelLock.state };
    }

    const status = {
      transport: config.transport,
      oauthConfigured: config.oauth.configured,
      apiKeyPresent: Boolean(config.apiKey),
      tokenFilePath: config.tokenFile,
      tokenPresent: Boolean(credentials),
      authenticated: Boolean(credentials && ctx.channelLock),
      authenticatedChannelId: ctx.channelLock?.channelId ?? null,
      authenticatedChannelTitle: ctx.channelLock?.channelTitle ?? null,
      allowedChannelId: config.allowedChannelId,
      channelLockState: binding?.state ?? BindingState.UNKNOWN,
      channelLockSatisfied: binding?.state === BindingState.VERIFIED,
      channelLockDetail: ctx.channelLock?.lastFailureReason ?? null,
      writesEnabled: config.writesEnabled,
      // From the stored token, never from the requested array.
      scopesGranted: credentials ? grantedScopes(credentials) : "unknown",
      scopesRequestedByThisServer: [...SCOPES],
      mediaDir: config.mediaDir,
      thumbnailMaxBytes: config.thumbnailMaxBytes,
    };

    return text(status);
  },

  async youtube_start_oauth(_args, ctx) {
    if (!ctx.startOAuth) {
      throw new Error(
        "Interactive OAuth is unavailable in this process. Run `npm run auth` locally."
      );
    }
    const result = await ctx.startOAuth();
    return text(result);
  },

  async reply_to_comment(args, ctx) {
    const youtube = requireYouTube(ctx);
    const lock = requireChannelLock(ctx);

    const target = await lock.resolveReplyTarget(args.parentId);

    try {
      const response = await youtube.comments.insert(
        {
          part: ["snippet"],
          requestBody: {
            snippet: {
              // The VERIFIED top-level parent, not the raw input.
              parentId: target.topLevelCommentId,
              textOriginal: args.text,
            },
          },
        },
        NO_RETRY
      );

      return text({
        posted: true,
        replyId: response.data?.id ?? null,
        videoId: target.videoId,
        parentCommentId: target.topLevelCommentId,
        note: target.inputWasReply
          ? `The supplied comment was itself a reply; the reply was attached to its top-level parent ${target.topLevelCommentId}.`
          : undefined,
      });
    } catch (error) {
      if (isTransientError(error)) {
        throw new Error(
          "The reply request failed without a definitive response, so it MAY " +
            "ALREADY HAVE BEEN POSTED. It was not retried automatically. Use " +
            `list_comments on video ${target.videoId} to check before trying again. ` +
            `(${sanitizeGoogleError(error)})`
        );
      }
      throw error;
    }
  },

  async update_video(args, ctx) {
    const youtube = requireYouTube(ctx);
    const lock = requireChannelLock(ctx);

    // Ownership check returns the current resource, so the merge below uses
    // real current state without a second round-trip.
    const video = await lock.assertVideoOwned(args.videoId);

    const snippet = buildSnippetUpdate(video.snippet, args);

    if (!snippet.title) {
      throw new Error(
        `Refusing to update video ${args.videoId}: no title is available to send, ` +
          "and videos.update requires one."
      );
    }
    if (!snippet.categoryId) {
      throw new Error(
        `Refusing to update video ${args.videoId}: no categoryId is available to ` +
          "send, and videos.update requires one."
      );
    }

    // part is ["snippet"] ONLY. Because status is not listed, privacy and the
    // made-for-kids declaration cannot be touched by this tool at all - that is
    // structural, not a matter of omitting an argument.
    await youtube.videos.update(
      {
        part: ["snippet"],
        requestBody: { id: args.videoId, snippet },
      },
      NO_RETRY
    );

    const changed = ["title", "description", "tags"].filter(
      (field) => args[field] !== undefined
    );

    return text({
      updated: true,
      videoId: args.videoId,
      fieldsChanged: changed,
      fieldsPreserved: Object.keys(snippet).filter((f) => !changed.includes(f)),
      privacyUnchanged: true,
      note: "Only the snippet part was sent, so privacy and audience settings were not included in the request.",
    });
  },

  async set_video_privacy(args, ctx) {
    const youtube = requireYouTube(ctx);
    const lock = requireChannelLock(ctx);

    const video = await lock.assertVideoOwned(args.videoId);

    const { status, notes, warnings, resultingSchedule } = buildStatusUpdate(
      video.status,
      { privacyStatus: args.privacyStatus, scheduledPublish: args.scheduledPublish }
    );

    // part is ["status"] ONLY: metadata is untouched.
    await youtube.videos.update(
      {
        part: ["status"],
        requestBody: { id: args.videoId, status },
      },
      NO_RETRY
    );

    return text({
      updated: true,
      videoId: args.videoId,
      previousPrivacy: video.status?.privacyStatus ?? null,
      resultingPrivacy: args.privacyStatus,
      resultingScheduledPublish: resultingSchedule,
      notes,
      warnings,
      metadataUnchanged: true,
    });
  },

  async set_thumbnail(args, ctx) {
    const youtube = requireYouTube(ctx);
    const lock = requireChannelLock(ctx);

    const hasPath = args.imagePath !== undefined;
    const hasUrl = args.imageUrl !== undefined;
    if (hasPath === hasUrl) {
      throw new MediaError(
        "Provide exactly one of imagePath (a file inside YOUTUBE_MEDIA_DIR) or " +
          "imageUrl (a public HTTPS image)."
      );
    }

    // Ownership first: never fetch or read media for a video we may not modify.
    await lock.assertVideoOwned(args.videoId);

    const image = hasPath
      ? await resolveThumbnailPath(ctx.config, args.imagePath)
      : await fetchThumbnailUrl(ctx.config, args.imageUrl);

    await youtube.thumbnails.set(
      {
        videoId: args.videoId,
        media: {
          mimeType: image.mimeType,
          body: Readable.from(image.buffer),
        },
      },
      NO_RETRY
    );

    return text({
      updated: true,
      videoId: args.videoId,
      source: hasPath ? `media dir: ${image.source}` : image.source,
      mimeType: image.mimeType,
      bytes: image.buffer.length,
      note: "The previous custom thumbnail is not recoverable through the API.",
    });
  },
});

/**
 * Build the Google API clients for a set of credentials.
 * Exported so the entry point and the auth helper share one construction path.
 */
export function buildGoogleClients({ oauth2Client, apiKey }) {
  if (oauth2Client) {
    return {
      youtube: google.youtube({ version: "v3", auth: oauth2Client }),
      // Constructed here rather than only after authorization - the original
      // code built it in the authorize handler alone, so analytics silently
      // broke after every restart.
      youtubeAnalytics: google.youtubeAnalytics({ version: "v2", auth: oauth2Client }),
    };
  }
  if (apiKey) {
    return {
      youtube: google.youtube({ version: "v3", auth: apiKey }),
      youtubeAnalytics: null,
    };
  }
  return { youtube: null, youtubeAnalytics: null };
}
