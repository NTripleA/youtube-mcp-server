/**
 * Streamable HTTP transport, stateless.
 *
 * A fresh Server + transport pair is built for every request. That is the SDK's
 * supported stateless lifecycle and it means no Protocol instance is shared
 * between concurrent callers; only the context object (Google clients, config,
 * channel-binding cache) is shared, and that is plain data plus idempotent
 * lookups.
 *
 * Host/Origin protection is ON by default. Note the asymmetry, which is the
 * SDK's behaviour and the one we want: a PRESENT but unlisted Origin is
 * rejected, while a request that omits Origin entirely (normal for
 * server-to-server clients) is not.
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../server.js";
import { sanitizeGoogleError } from "../logger.js";

class BodyTooLargeError extends Error {}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error, { destroy = true } = {}) => {
      if (settled) return;
      settled = true;
      if (destroy) req.destroy();
      reject(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop buffering but leave the socket alive: destroying it here would
        // mean the caller never receives the 413 it needs to see.
        req.pause();
        chunks.length = 0;
        fail(new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`), {
          destroy: false,
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on("error", fail);
    // Client disconnected mid-upload: stop buffering.
    req.on("aborted", () => fail(new Error("Request aborted by client")));
  });
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  res.end(body);
}

export async function startHttpTransport(ctx) {
  const { config, log } = ctx;

  // The SDK compares the Host header exactly, including port. When an ephemeral
  // port is requested the configured list cannot know it yet, so it is topped
  // up once the socket is actually bound.
  let allowedHosts = config.http.allowedHosts;

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }

    // Minimal and deliberately independent of Google: a health probe must not
    // fail because the YouTube API is having a bad day, and must not disclose
    // configuration. Account diagnostics live in the youtube_auth_status tool.
    if (url.pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendJson(res, 405, { error: "method not allowed" });
      }
      return sendJson(res, 200, { status: "ok" });
    }

    if (url.pathname !== config.http.path) {
      return sendJson(res, 404, { error: "not found" });
    }

    let body;
    if (req.method === "POST") {
      try {
        const raw = await readBody(req, config.http.maxBodyBytes);
        body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, {
            jsonrpc: "2.0",
            error: { code: -32600, message: "Request body too large" },
            id: null,
          });
          // Drain the rest of the upload rather than killing the socket
          // outright, so the client can finish writing and actually read the
          // 413 instead of seeing a connection reset. Bounded by a timer so a
          // client that never stops sending cannot hold the socket open.
          req.resume();
          const cutoff = setTimeout(() => req.destroy(), 5000);
          cutoff.unref?.();
          req.once("end", () => clearTimeout(cutoff));
          res.once("close", () => clearTimeout(cutoff));
          return;
        }
        if (error instanceof SyntaxError) {
          return sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          });
        }
        return; // aborted; nothing to answer
      }
    }

    // One Server + one transport per request: the stateless lifecycle.
    const mcpServer = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins: config.http.allowedOrigins,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      log?.error(`HTTP request failed: ${sanitizeGoogleError(error)}`);
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const boundPort = server.address()?.port ?? config.http.port;
  if (boundPort !== config.http.port) {
    allowedHosts = [
      ...new Set([
        ...allowedHosts,
        `127.0.0.1:${boundPort}`,
        `localhost:${boundPort}`,
        `[::1]:${boundPort}`,
      ]),
    ];
  }

  log?.info(
    `Streamable HTTP transport listening on http://${config.http.host}:${boundPort}${config.http.path} ` +
      `(health: /healthz, writes ${config.writesEnabled ? "ENABLED" : "disabled"})`
  );
  log?.info(`Allowed Host headers: ${allowedHosts.join(", ")}`);
  if (config.http.allowedOrigins.length) {
    log?.info(`Allowed Origins: ${config.http.allowedOrigins.join(", ")}`);
  }

  return {
    server,
    address: server.address(),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
