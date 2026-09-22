#!/usr/bin/env node
/**
 * Entry point.
 *
 * Invoking `node index.js` with no arguments still starts the stdio server
 * exactly as before, so an existing Claude Desktop configuration keeps working.
 * `--http` (or MCP_TRANSPORT=http) starts the Streamable HTTP server instead.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { loadConfig } from "./src/config.js";
import { createLogger, sanitizeGoogleError } from "./src/logger.js";
import { createContext, validateStartup } from "./src/bootstrap.js";
import { startStdioTransport } from "./src/transports/stdio.js";
import { startHttpTransport } from "./src/transports/http.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// Tests set MCP_SKIP_DOTENV=1 so they can never pick up the operator's real
// credentials from a local .env file.
if (process.env.MCP_SKIP_DOTENV !== "1") {
  dotenv.config({ path: path.join(projectRoot, ".env") });
}

async function main() {
  const log = createLogger();

  let config;
  try {
    config = loadConfig(process.env, { argv: process.argv.slice(2) });
  } catch (error) {
    log.error(`Configuration error: ${error.message}`);
    process.exit(1);
  }

  log.info(
    `Starting in ${config.transport} mode ` +
      `(OAuth ${config.oauth.configured ? "configured" : "not configured"}, ` +
      `API key ${config.apiKey ? "present" : "absent"}, ` +
      `writes ${config.writesEnabled ? "ENABLED" : "disabled"})`
  );

  const ctx = await createContext(config, { log });

  const { fatal } = await validateStartup(ctx);
  if (fatal) {
    log.error(fatal);
    process.exit(1);
  }

  const handle = config.isRemote
    ? await startHttpTransport(ctx)
    : await startStdioTransport(ctx);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    await handle.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `[youtube-mcp] fatal: ${sanitizeGoogleError(error)}\n`
  );
  process.exit(1);
});
