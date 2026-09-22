/**
 * Server-side channel lock.
 *
 * The premise: "Google's OAuth succeeded" proves only that SOME account
 * authorized us. It does not prove the token belongs to the channel this
 * deployment is allowed to modify. Every write therefore deterministically
 * verifies the target against YOUTUBE_ALLOWED_CHANNEL_ID before anything is
 * mutated.
 */

import { isTransientError, sanitizeGoogleError } from "./logger.js";

export const BindingState = Object.freeze({
  UNKNOWN: "unknown",
  VERIFIED: "verified",
  MISMATCH: "mismatch",
  UNVERIFIED: "unverified",
});

/** Refusal that is the operator's to fix (wrong channel, foreign video, ...). */
export class WriteBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "WriteBlockedError";
    this.transient = false;
  }
}

/** Refusal caused by an outage. Writes stay closed; reads keep working. */
export class BindingUnverifiedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BindingUnverifiedError";
    this.transient = true;
  }
}

/** How long to wait before re-probing after a transient verification failure. */
const UNVERIFIED_BACKOFF_MS = 10_000;

export class ChannelLock {
  /**
   * @param {{youtube: object, allowedChannelId: string|null, log?: object,
   *          now?: () => number}} options
   */
  constructor({ youtube, allowedChannelId, log = null, now = Date.now }) {
    this.youtube = youtube;
    this.allowedChannelId = allowedChannelId;
    this.log = log;
    this.now = now;

    this.state = BindingState.UNKNOWN;
    this.channelId = null;
    this.channelTitle = null;
    this.lastFailureReason = null;
    this._lastAttemptAt = 0;
  }

  get isConfigured() {
    return Boolean(this.allowedChannelId);
  }

  /**
   * Resolve the authenticated channel and compare it with the allow-listed one.
   *
   * Three outcomes, never two:
   *   VERIFIED    a definitive answer, and it matches.
   *   MISMATCH    a definitive answer naming a different channel.
   *   UNVERIFIED  we could not get an answer (network/API outage, quota).
   *
   * Only VERIFIED is ever cached. A failure is never cached as success.
   */
  async ensureBinding({ force = false } = {}) {
    if (!this.isConfigured) {
      return { state: BindingState.UNKNOWN, reason: "no allowed channel configured" };
    }
    if (this.state === BindingState.VERIFIED && !force) {
      return this._snapshot();
    }
    if (this.state === BindingState.MISMATCH && !force) {
      return this._snapshot();
    }
    if (
      this.state === BindingState.UNVERIFIED &&
      !force &&
      this.now() - this._lastAttemptAt < UNVERIFIED_BACKOFF_MS
    ) {
      // Back off rather than hammering an API that is already failing.
      return this._snapshot();
    }

    this._lastAttemptAt = this.now();

    let response;
    try {
      response = await this.youtube.channels.list({
        part: ["id", "snippet"],
        mine: true,
      });
    } catch (error) {
      if (isTransientError(error)) {
        this.state = BindingState.UNVERIFIED;
        this.lastFailureReason = sanitizeGoogleError(error);
        this.log?.warn(
          `Channel binding could not be verified (transient): ${this.lastFailureReason}. ` +
            "Writes are blocked; read-only tools continue to serve."
        );
        return this._snapshot();
      }
      // A definitive error (401/403 - token revoked, wrong credentials) is not
      // a match, and pretending it is transient would keep a dead deployment
      // half-alive. Treat it as a mismatch.
      this.state = BindingState.MISMATCH;
      this.lastFailureReason = sanitizeGoogleError(error);
      return this._snapshot();
    }

    const item = response?.data?.items?.[0];
    if (!item?.id) {
      // An empty list is a definitive answer: this account has no channel.
      this.state = BindingState.MISMATCH;
      this.channelId = null;
      this.channelTitle = null;
      this.lastFailureReason =
        "the authenticated Google account has no YouTube channel";
      return this._snapshot();
    }

    this.channelId = item.id;
    this.channelTitle = item.snippet?.title ?? null;

    if (item.id === this.allowedChannelId) {
      this.state = BindingState.VERIFIED;
      this.lastFailureReason = null;
    } else {
      this.state = BindingState.MISMATCH;
      this.lastFailureReason =
        `authenticated channel ${item.id} does not match ` +
        `YOUTUBE_ALLOWED_CHANNEL_ID ${this.allowedChannelId}`;
    }

    return this._snapshot();
  }

  _snapshot() {
    return {
      state: this.state,
      channelId: this.channelId,
      channelTitle: this.channelTitle,
      allowedChannelId: this.allowedChannelId,
      reason: this.lastFailureReason,
    };
  }

  /**
   * Gate every write. Throws unless the binding is VERIFIED.
   */
  async assertWritable() {
    if (!this.isConfigured) {
      throw new WriteBlockedError(
        "Write blocked: YOUTUBE_ALLOWED_CHANNEL_ID is not set, so the target " +
          "channel cannot be verified. Set it to the channel this deployment " +
          "is allowed to modify."
      );
    }

    const binding = await this.ensureBinding();

    if (binding.state === BindingState.VERIFIED) return binding;

    if (binding.state === BindingState.UNVERIFIED) {
      throw new BindingUnverifiedError(
        "Write blocked: the authenticated channel could not be verified right " +
          `now (${binding.reason}). Read-only tools are unaffected; retry the ` +
          "write once the YouTube API is reachable."
      );
    }

    throw new WriteBlockedError(
      `Write blocked: ${binding.reason ?? "the authenticated channel does not match the allowed channel"}.`
    );
  }

  /**
   * Verify a video belongs to the allowed channel and return the fetched
   * resource, so callers can merge against real current state without a second
   * round-trip.
   */
  async assertVideoOwned(videoId) {
    await this.assertWritable();

    let response;
    try {
      response = await this.youtube.videos.list({
        part: ["snippet", "status"],
        id: [videoId],
      });
    } catch (error) {
      if (isTransientError(error)) {
        throw new BindingUnverifiedError(
          `Write blocked: could not confirm ownership of video ${videoId} ` +
            `(${sanitizeGoogleError(error)}). Nothing was modified.`
        );
      }
      throw new WriteBlockedError(
        `Write blocked: could not confirm ownership of video ${videoId} ` +
          `(${sanitizeGoogleError(error)}). Nothing was modified.`
      );
    }

    const video = response?.data?.items?.[0];
    if (!video) {
      throw new WriteBlockedError(
        `Write blocked: video ${videoId} was not found, so ownership could not be verified.`
      );
    }

    const owner = video.snippet?.channelId;
    if (!owner) {
      throw new WriteBlockedError(
        `Write blocked: video ${videoId} returned no channelId, so ownership could not be verified.`
      );
    }
    if (owner !== this.allowedChannelId) {
      throw new WriteBlockedError(
        `Write blocked: video ${videoId} belongs to channel ${owner}, not the ` +
          `allowed channel ${this.allowedChannelId}.`
      );
    }

    return video;
  }

  /**
   * Resolve a reply target from user-supplied `parentId`.
   *
   * Never assumes a comment thread's ID equals its top-level comment's ID -
   * every relationship is read back from the API and checked. Fails closed if
   * anything cannot be established.
   *
   * @returns {Promise<{topLevelCommentId: string, videoId: string, video: object,
   *                    inputWasReply: boolean}>}
   */
  async resolveReplyTarget(parentId) {
    await this.assertWritable();

    let commentResponse;
    try {
      commentResponse = await this.youtube.comments.list({
        part: ["snippet"],
        id: [parentId],
      });
    } catch (error) {
      const Err = isTransientError(error) ? BindingUnverifiedError : WriteBlockedError;
      throw new Err(
        `Reply blocked: could not look up comment ${parentId} ` +
          `(${sanitizeGoogleError(error)}). Nothing was posted.`
      );
    }

    const comment = commentResponse?.data?.items?.[0];
    if (!comment?.id) {
      throw new WriteBlockedError(
        `Reply blocked: comment ${parentId} was not found, so its video could not be verified.`
      );
    }

    // If the supplied comment is itself a reply, the real insert target is its
    // parent - taken from the API response, not inferred from the input.
    const parentOfComment = comment.snippet?.parentId ?? null;
    const topLevelCommentId = parentOfComment ?? comment.id;
    const inputWasReply = Boolean(parentOfComment);

    let videoId = comment.snippet?.videoId ?? null;

    if (!videoId) {
      // Fall back to the thread, and VERIFY the thread really owns this
      // top-level comment before trusting its videoId.
      let threadResponse;
      try {
        threadResponse = await this.youtube.commentThreads.list({
          part: ["snippet"],
          id: [topLevelCommentId],
        });
      } catch (error) {
        const Err = isTransientError(error)
          ? BindingUnverifiedError
          : WriteBlockedError;
        throw new Err(
          `Reply blocked: could not resolve the comment thread for ${topLevelCommentId} ` +
            `(${sanitizeGoogleError(error)}). Nothing was posted.`
        );
      }

      const thread = threadResponse?.data?.items?.[0];
      const threadTopLevelId = thread?.snippet?.topLevelComment?.id;

      if (!thread || threadTopLevelId !== topLevelCommentId) {
        throw new WriteBlockedError(
          `Reply blocked: the comment thread for ${topLevelCommentId} could not be ` +
            "confirmed, so the target video is unknown."
        );
      }

      videoId = thread.snippet?.videoId ?? null;
    }

    if (!videoId) {
      throw new WriteBlockedError(
        `Reply blocked: comment ${parentId} is not associated with a video, so ` +
          "channel ownership cannot be verified."
      );
    }

    // Ownership is checked on the VIDEO's channel, never the comment author's -
    // a viewer from another channel commenting on our video stays replyable.
    const video = await this.assertVideoOwned(videoId);

    return { topLevelCommentId, videoId, video, inputWasReply };
  }
}
