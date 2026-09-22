/**
 * stdio transport - the original local behaviour, unchanged.
 * stdout carries the JSON-RPC stream, so all logging goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../server.js";

export async function startStdioTransport(ctx) {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  ctx.log?.info(
    `stdio transport ready (writes ${ctx.config.writesEnabled ? "ENABLED" : "disabled"})`
  );

  return {
    async close() {
      await server.close().catch(() => {});
    },
  };
}
