/**
 * The MCP server itself.
 *
 * One factory serves both transports. In HTTP (stateless) mode it is called
 * once PER REQUEST, so no Protocol instance is ever shared across concurrent
 * requests; what is shared is the context object - Google clients, config and
 * the channel-binding cache - which is plain data plus idempotent lookups.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { HANDLERS, TOOLS_BY_NAME, ToolKind, visibleTools } from "./tools.js";
import { validateToolArgs } from "./validate.js";
import { sanitizeGoogleError } from "./logger.js";

export const SERVER_INFO = Object.freeze({
  name: "youtube-mcp-server",
  version: "3.0.0",
});

const POPULAR_VIDEOS_URI = "youtube://popular/videos";

/**
 * Enforce the restrictions that tools/list also expresses.
 *
 * Discovery filtering is a hint to well-behaved clients. A client holding a
 * cached tool list can still call a hidden tool by name, so the same rules are
 * applied here, before any Google client is touched.
 *
 * @returns {string|null} refusal message, or null when the call may proceed
 */
export function dispatchRefusal(tool, config) {
  if (tool.kind === ToolKind.WRITE && !config.writesEnabled) {
    return (
      `Write blocked: ${tool.name} is disabled because YOUTUBE_ENABLE_WRITES is ` +
      "not enabled for this deployment. No YouTube API call was made."
    );
  }
  if (tool.kind === ToolKind.LOCAL && config.isRemote) {
    return (
      `${tool.name} is unavailable over HTTP: interactive authorization is a ` +
      "local-only operation. Run `npm run auth` on the machine that holds the " +
      "OAuth client secret, then copy the token file to this deployment."
    );
  }
  return null;
}

/**
 * @param {object} ctx { config, log, youtube, youtubeAnalytics, channelLock,
 *                       credentials, startOAuth }
 */
export function createMcpServer(ctx) {
  const server = new Server(SERVER_INFO, {
    capabilities: { resources: {}, tools: {} },
  });

  server.onerror = (error) => {
    ctx.log?.error(`[MCP] ${sanitizeGoogleError(error)}`);
  };

  // -- resources ------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: POPULAR_VIDEOS_URI,
        name: "Popular YouTube videos",
        mimeType: "application/json",
        description: "Currently popular videos on YouTube",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== POPULAR_VIDEOS_URI) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unknown resource: ${request.params.uri}`
      );
    }
    if (!ctx.youtube) {
      throw new McpError(
        ErrorCode.InternalError,
        "YouTube API is not configured"
      );
    }

    try {
      const response = await ctx.youtube.videos.list({
        part: ["snippet", "statistics"],
        chart: "mostPopular",
        maxResults: 10,
      });

      const videos = (response.data?.items ?? []).map((video) => ({
        title: video.snippet?.title,
        id: video.id,
        url: `https://www.youtube.com/watch?v=${video.id}`,
        channelTitle: video.snippet?.channelTitle,
        viewCount: video.statistics?.viewCount,
        publishedAt: video.snippet?.publishedAt,
        description: video.snippet?.description,
      }));

      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(videos, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `YouTube API error: ${sanitizeGoogleError(error)}`
      );
    }
  });

  // -- tools ----------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools(ctx.config).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    const tool = TOOLS_BY_NAME[name];
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }

    try {
      const refusal = dispatchRefusal(tool, ctx.config);
      if (refusal) {
        return {
          content: [{ type: "text", text: refusal }],
          isError: true,
        };
      }

      const args = validateToolArgs(name, rawArgs);
      return await HANDLERS[name](args, ctx);
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${sanitizeGoogleError(error)}` }],
        isError: true,
      };
    }
  });

  return server;
}
