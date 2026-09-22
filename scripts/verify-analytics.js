#!/usr/bin/env node
/**
 * Opt-in, manually run, READ-ONLY post-authorization check.
 *
 * Confirms that the granted scopes really do permit a YouTube Analytics query -
 * the one thing that cannot be proven from the token's scope string alone,
 * because the Analytics API and the Data API disagree about which scope the
 * reference documentation names.
 *
 * Never invoked by the test suite and never by the server. It reads; it changes
 * nothing.
 *
 *   npm run verify:analytics
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { loadConfig } from "../src/config.js";
import { createLogger, sanitizeGoogleError } from "../src/logger.js";
import { createContext } from "../src/bootstrap.js";
import { grantedScopes } from "../src/auth.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (process.env.MCP_SKIP_DOTENV !== "1") {
  dotenv.config({ path: path.join(projectRoot, ".env") });
}

function isoDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const log = createLogger({ prefix: "youtube-mcp verify" });
  const config = loadConfig({ ...process.env, MCP_TRANSPORT: "stdio" }, { argv: [] });
  const ctx = await createContext(config, { log });

  if (!ctx.credentials) {
    console.error(
      `No token found at ${config.tokenFile}. Run \`npm run auth\` first.`
    );
    process.exit(1);
  }

  const scopes = grantedScopes(ctx.credentials);
  console.log("\nGranted scopes (read from the stored token, not assumed):");
  if (scopes === "unknown") {
    console.log("  unknown - the token carries no scope field");
  } else {
    for (const scope of scopes) console.log(`  ${scope}`);
  }

  if (!ctx.channelLock) {
    console.error("\nOAuth client unavailable; cannot continue.");
    process.exit(1);
  }

  console.log("\nResolving the authenticated channel...");
  const binding = await ctx.channelLock.ensureBinding({ force: true });
  console.log(`  state:      ${binding.state}`);
  console.log(`  channel:    ${ctx.channelLock.channelId ?? "unknown"}`);
  console.log(`  title:      ${ctx.channelLock.channelTitle ?? "unknown"}`);
  console.log(`  allowed:    ${config.allowedChannelId ?? "(not configured)"}`);
  if (binding.reason) console.log(`  detail:     ${binding.reason}`);

  console.log("\nRunning a read-only Analytics query (last 28 days, views)...");
  try {
    const response = await ctx.youtubeAnalytics.reports.query({
      ids: "channel==MINE",
      startDate: isoDaysAgo(28),
      endDate: isoDaysAgo(1),
      metrics: "views",
    });
    console.log("  OK - Analytics responded:");
    console.log(`  ${JSON.stringify(response.data?.rows ?? [])}`);
    console.log("\nAnalytics access is working.\n");
  } catch (error) {
    console.error(`  FAILED: ${sanitizeGoogleError(error)}`);
    console.error(
      "\nIf this reports insufficient permissions, re-run `npm run auth` so the\n" +
        "yt-analytics.readonly and youtube.readonly scopes are granted.\n"
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(sanitizeGoogleError(error));
  process.exit(1);
});
