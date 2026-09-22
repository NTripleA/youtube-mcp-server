#!/usr/bin/env node
/**
 * One-time OAuth provisioning, run locally on the machine that holds the OAuth
 * client secret. Never run this on the Pi - copy the resulting token file there.
 *
 *   npm run auth
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { TokenStore } from "../src/auth.js";
import { runLoopbackOAuth } from "../src/oauth-flow.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (process.env.MCP_SKIP_DOTENV !== "1") {
  dotenv.config({ path: path.join(projectRoot, ".env") });
}

function tryOpenBrowser(url) {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printing the URL is the real interface; opening a browser is a nicety.
  }
}

async function main() {
  const log = createLogger({ prefix: "youtube-mcp auth" });

  // Authorization is inherently a local operation; force stdio defaults so a
  // stray MCP_TRANSPORT=http in the environment cannot change the token path.
  const config = loadConfig(
    { ...process.env, MCP_TRANSPORT: "stdio" },
    { argv: [] }
  );

  if (!config.oauth.configured) {
    log.error(
      "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET first (Google Cloud " +
        "Console > Credentials > OAuth client ID > Desktop app)."
    );
    process.exit(1);
  }

  const tokenStore = new TokenStore(config.tokenFile, { log });

  console.log(`\nToken will be stored at: ${config.tokenFile}\n`);

  let result;
  try {
    result = await runLoopbackOAuth({
      config,
      tokenStore,
      log,
      onAuthUrl: (url) => {
        console.log("Open this URL to authorize (it should open automatically):\n");
        console.log(`  ${url}\n`);
        tryOpenBrowser(url);
      },
    });
  } catch (error) {
    log.error(error.message);
    process.exit(1);
  }

  console.log("\nAuthorization complete.\n");
  console.log(`  Token file:        ${result.tokenFile}`);
  console.log(`  Refresh token:     ${result.refreshTokenStored ? "stored" : "MISSING"}`);
  console.log(
    `  Scopes granted:    ${
      result.scopesGranted === "unknown"
        ? "unknown (Google returned no scope field)"
        : result.scopesGranted.join("\n                     ")
    }`
  );
  if (result.channel) {
    console.log(`  Channel:           ${result.channel.id} (${result.channel.title ?? "untitled"})`);
    console.log(
      `\nSet this on the deployment:\n  YOUTUBE_ALLOWED_CHANNEL_ID=${result.channel.id}\n`
    );
  } else {
    console.log("  Channel:           could not be read back; check manually.\n");
  }

  console.log(
    "IMPORTANT - check the OAuth app's publishing status in Google Cloud Console\n" +
      "(APIs & Services > OAuth consent screen). An app left on 'External + Testing'\n" +
      "issues refresh tokens that EXPIRE AFTER SEVEN DAYS, which will silently break\n" +
      "the deployment a week from now. Move it to 'In production' (or plan to\n" +
      "re-authorize weekly).\n"
  );
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
