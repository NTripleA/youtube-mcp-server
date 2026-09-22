# YouTube MCP Server

<div align="center">
  <img src="https://img.shields.io/badge/YouTube_API-v3-red" alt="YouTube API Version">
  <img src="https://img.shields.io/badge/MCP-Model_Context_Protocol-green" alt="MCP">
  <img src="https://img.shields.io/badge/Claude-compatible-blue" alt="Claude Compatible">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="License">
</div>

An MCP server that lets Claude, ChatGPT and other assistants work with YouTube:
public search and video data, channel analytics, and a small set of
**channel-locked** write tools for day-to-day channel management.

Runs over **stdio** locally and **Streamable HTTP** for remote deployment, from
one shared implementation.

## What is MCP?

The Model Context Protocol is an open standard from Anthropic for connecting AI
assistants to external data and tools, so a model can work with live information
and take actions in other systems in a standardised way.

## Requirements

- Node.js 20.10 or newer
- A YouTube Data API key (public reads)
- A Google OAuth "Desktop app" client (analytics and writes)

## Installation

```bash
git clone https://github.com/Nocodeboy/youtube-mcp-server.git
cd youtube-mcp-server
npm ci
cp .env.example .env    # then fill it in
```

## Tools

### Read (no OAuth needed beyond an API key)

| Tool | Description |
|---|---|
| `search_videos` | Search YouTube for videos |
| `get_video_details` | Snippet, statistics and status for one video |
| `list_comments` | Comment threads on a video |
| `youtube_auth_status` | Safe diagnostics: OAuth configured, authenticated channel, allowed channel, whether they match, writes on/off, granted scopes. Never returns tokens or secrets |

### Read (OAuth required)

| Tool | Description |
|---|---|
| `analytics_top_videos` | Top videos by metric over a date range |
| `analytics_video_metrics` | Metrics for one video over a date range |

Both are scoped to the authenticated channel (`channel==MINE`).

### Write (OAuth + channel lock + write switch)

| Tool | Description |
|---|---|
| `reply_to_comment` | Reply to a comment on one of your videos |
| `update_video` | Change title, description or tags. **Cannot change privacy** |
| `set_video_privacy` | Change privacy to private / unlisted / public |
| `set_thumbnail` | Set a custom thumbnail from a local file or a public HTTPS URL |

There are **no delete tools**, by design.

### Local only (stdio)

| Tool | Description |
|---|---|
| `youtube_start_oauth` | Run the Google Desktop OAuth loopback flow. Refused over HTTP |

### Resources

- `youtube://popular/videos` — currently popular videos

## Safety model

Three independent gates sit in front of every write, checked in this order:

1. **Write switch** — `YOUTUBE_ENABLE_WRITES`. Off by default in HTTP mode, on
   in stdio mode. When off, write tools are hidden from `tools/list` *and*
   refused by name at dispatch, before any Google client is touched.
2. **Channel lock** — `YOUTUBE_ALLOWED_CHANNEL_ID`. The authenticated channel is
   resolved through the API and compared against it; then every write
   re-verifies that its specific target belongs to that channel. A successful
   Google OAuth is not treated as proof of anything on its own.
3. **Per-target ownership** — `update_video`, `set_video_privacy` and
   `set_thumbnail` verify the video's `channelId`; `reply_to_comment` resolves
   the comment to its video and verifies *that video's* channel (so a viewer
   from another channel commenting on your video stays replyable).

If the binding cannot be verified because of a network or API outage, writes
fail closed while read-only tools keep working, and verification is retried on
the next write.

### Metadata and privacy

`videos.update` overwrites every mutable property in any `part` you send, so:

- `update_video` sends **only** the `snippet` part. Privacy and audience
  settings are structurally unreachable from it, not merely omitted.
- `set_video_privacy` sends **only** the `status` part, so metadata is untouched.
- Both fetch current state first and merge, preserving unspecified fields.
- An explicit made-for-kids declaration is preserved verbatim and never
  synthesized from the read-only `madeForKids` value.
- A video with a scheduled publish time requires an explicit
  `scheduledPublish: "preserve" | "cancel"` — a schedule is never silently kept
  or silently dropped.

### Thumbnails

Exactly one of `imagePath` or `imageUrl`:

- **`imagePath`** is canonicalised and confined to `YOUTUBE_MEDIA_DIR`;
  traversal, absolute paths and symlink escapes are refused.
- **`imageUrl`** must be public HTTPS. Private, loopback, link-local and
  cloud-metadata addresses are refused before connecting and again on every
  redirect; the downloaded bytes must actually be a JPEG or PNG.

## OAuth scopes

Only what the implemented methods need:

| Scope | Why |
|---|---|
| `youtube.force-ssl` | The only scope `comments.insert` and `commentThreads.list` accept; also covers `videos.update`, `thumbnails.set`, `videos.list`, `channels.list`, `search.list` |
| `youtube.readonly` | Named by the YouTube Analytics reference for `reports.query`. Read-only, so it adds no write capability |
| `yt-analytics.readonly` | Required for `reports.query` |

The broad `https://www.googleapis.com/auth/youtube` scope is **not** requested.

## Authorization

```bash
npm run auth
```

Opens a browser, receives the redirect on a temporary `127.0.0.1` listener
(PKCE, `access_type=offline`), and stores the token at
`~/.config/youtube-mcp/token.json` — **never** inside the repository; the server
refuses to start if the token path resolves into the checkout. It prints the
granted scopes and your channel ID.

Optional read-only verification of Analytics access:

```bash
npm run verify:analytics
```

> **Check your OAuth app's publishing status.** An app left on *External +
> Testing* issues refresh tokens that expire after **seven days**.

## Running

### Local (stdio) — Claude Desktop

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/absolute/path/to/youtube-mcp-server/index.js"],
      "env": {
        "YOUTUBE_API_KEY": "your_api_key_here",
        "YOUTUBE_CLIENT_ID": "your_client_id",
        "YOUTUBE_CLIENT_SECRET": "your_client_secret",
        "YOUTUBE_ALLOWED_CHANNEL_ID": "UC..."
      }
    }
  }
}
```

### Remote (Streamable HTTP)

```bash
npm run start:http
```

Serves `/mcp` and a minimal `/healthz`. Binds `127.0.0.1` by default; Host/Origin
protection is on by default. See **[docs/DEPLOY-PI.md](docs/DEPLOY-PI.md)** for
the Raspberry Pi + Docker + Cloudflare Tunnel deployment.

## Configuration

Every variable is documented in [.env.example](.env.example). The ones that
matter most:

| Variable | Default | Purpose |
|---|---|---|
| `YOUTUBE_API_KEY` | — | Public reads |
| `YOUTUBE_CLIENT_ID` / `_SECRET` | — | OAuth client |
| `YOUTUBE_TOKEN_FILE` | `~/.config/youtube-mcp/token.json` | Token location, never in the checkout |
| `YOUTUBE_ALLOWED_CHANNEL_ID` | — | The only channel writes may touch |
| `YOUTUBE_ENABLE_WRITES` | `false` (http) / `true` (stdio) | Write switch |
| `YOUTUBE_MEDIA_DIR` | `/media` (http) / unset | Thumbnail directory |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` / `_PORT` | `127.0.0.1` / `8000` | HTTP bind address |
| `MCP_ALLOWED_HOSTS` | loopback | Extends the Host allowlist |

## Development

```bash
npm test     # 241 tests, no network, no real credentials touched
npm run check
```

Tests run with the environment scrubbed and Google APIs mocked; none of them can
reach YouTube or modify a real channel.

## Troubleshooting

1. Dependencies installed with `npm ci`, Node 20.10+
2. YouTube Data API v3 **and** YouTube Analytics API enabled in your project
3. Call `youtube_auth_status` — it reports exactly which gate is closed
4. Writes refused? Check `YOUTUBE_ENABLE_WRITES` and that the authenticated
   channel matches `YOUTUBE_ALLOWED_CHANNEL_ID`
5. Claude Desktop logs: `~/Library/Logs/Claude/` (macOS),
   `%APPDATA%\Claude\logs\` (Windows)

## Contributions

Contributions are welcome:

1. Reporting bugs or issues
2. Suggesting new features
3. Sending pull requests with improvements or fixes
4. Improving documentation

## Connect & Support

- Follow me on X (Twitter): [@Nocodeboy](https://x.com/Nocodeboy)
- If you find this project useful and want to show your support:

<a href="https://www.buymeacoffee.com/germanhuertas" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## License

This project is licensed under the MIT License. See the LICENSE file for more details.
