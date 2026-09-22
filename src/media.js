/**
 * Thumbnail input safety.
 *
 * Two supported inputs, exactly one per call:
 *   imagePath - a file, canonicalised and confined to YOUTUBE_MEDIA_DIR.
 *   imageUrl  - a public HTTPS image, fetched through an SSRF-hardened client.
 *
 * The remote MCP must never become an arbitrary filesystem reader or an
 * arbitrary outbound HTTP client.
 */

import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import dns from "node:dns";
import ipaddr from "ipaddr.js";
import { isInside } from "./config.js";
import { redactUrl } from "./logger.js";

/** MIME types thumbnails.set accepts, intersected with what we can verify. */
export const ACCEPTED_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png"]);

const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 5_000;

export class MediaError extends Error {
  constructor(message) {
    super(message);
    this.name = "MediaError";
  }
}

/**
 * Identify real image bytes. A Content-Type header is a claim by the server;
 * this is the check that the bytes actually are what was claimed.
 */
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((byte, index) => buffer[index] === byte)) {
    return "image/png";
  }
  return null;
}

/**
 * Classify an IP address as safe to connect to.
 *
 * Uses ipaddr.js rather than hand-rolled parsing: only the `unicast` range is
 * allowed, which excludes loopback, private, link-local, unique-local,
 * multicast, broadcast, carrier-grade NAT and reserved space for both families.
 * IPv4-mapped IPv6 is unwrapped and re-checked so ::ffff:127.0.0.1 cannot slip
 * through as "IPv6 unicast".
 */
export function assertSafeAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(String(address));
  } catch {
    throw new MediaError(`Blocked thumbnail URL: unparseable IP address`);
  }

  if (parsed.kind() === "ipv6") {
    if (parsed.isIPv4MappedAddress()) {
      return assertSafeAddress(parsed.toIPv4Address().toString());
    }
    // 6to4/teredo/rfc6052/rfc6145 embed IPv4 that may be internal; only plain
    // unicast is allowed through.
    const range = parsed.range();
    if (range !== "unicast") {
      throw new MediaError(
        `Blocked thumbnail URL: resolves to a non-public IPv6 address (${range})`
      );
    }
    return true;
  }

  const range = parsed.range();
  if (range !== "unicast") {
    throw new MediaError(
      `Blocked thumbnail URL: resolves to a non-public address (${range})`
    );
  }
  return true;
}

/** Strip the brackets Node puts around an IPv6 hostname. */
function unbracket(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Validate a URL before any connection is attempted.
 *
 * WHATWG `URL` already normalises alternate IPv4 spellings (decimal, hex,
 * octal) into dotted-quad form, so an IP literal is classified here rather than
 * only at DNS time.
 */
export function assertSafeUrl(rawUrl, config) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new MediaError("Blocked thumbnail URL: not a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new MediaError(
      `Blocked thumbnail URL: only https:// is allowed (got ${url.protocol.replace(":", "")}://)`
    );
  }

  if (url.username || url.password) {
    throw new MediaError(
      "Blocked thumbnail URL: embedded credentials are not allowed"
    );
  }

  const host = unbracket(url.hostname).toLowerCase();
  if (!host) {
    throw new MediaError("Blocked thumbnail URL: missing host");
  }

  // Optional extra narrowing; not required for ordinary public images.
  const allowList = config.thumbnailUrlAllowedHosts ?? [];
  if (allowList.length > 0 && !allowList.includes(host)) {
    throw new MediaError(
      `Blocked thumbnail URL: host is not in YOUTUBE_THUMBNAIL_URL_ALLOWED_HOSTS`
    );
  }

  // An IP literal is classified now - before DNS, before connecting.
  if (ipaddr.isValid(host)) {
    assertSafeAddress(host);
  }

  return url;
}

/**
 * DNS lookup that validates the address actually used for the connection.
 * This closes the TOCTOU window a pre-flight `dns.resolve` would leave open:
 * whatever the socket connects to is what gets checked.
 */
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses?.length) {
      return callback(new MediaError("Blocked thumbnail URL: host did not resolve"));
    }

    try {
      // Strict: if ANY resolved address is unsafe, refuse the host outright
      // rather than racing to pick a good one.
      for (const entry of addresses) {
        assertSafeAddress(entry.address);
      }
    } catch (error) {
      return callback(error);
    }

    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(url, { deadline, maxBytes, signal, requestFn = https.request, now = Date.now }) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return reject(new MediaError("Blocked thumbnail URL: total time limit exceeded"));
    }

    const request = requestFn(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        // TLS verification stays on. No agent override, no rejectUnauthorized.
        headers: {
          // Deliberately minimal: no cookies, no Authorization, no Google or
          // MCP credentials, and no caller-supplied headers of any kind.
          accept: ACCEPTED_IMAGE_TYPES.join(","),
          "user-agent": "youtube-mcp-server",
        },
        timeout: Math.min(SOCKET_TIMEOUT_MS, remaining),
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          response.resume();
          if (!location) {
            return reject(
              new MediaError("Blocked thumbnail URL: redirect without a location")
            );
          }
          return resolve({ redirectTo: new URL(location, url).toString() });
        }

        if (status !== 200) {
          response.resume();
          return reject(
            new MediaError(
              `Blocked thumbnail URL: server responded ${status} for ${redactUrl(url)}`
            )
          );
        }

        const declared = String(response.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (!ACCEPTED_IMAGE_TYPES.includes(declared)) {
          response.resume();
          return reject(
            new MediaError(
              `Blocked thumbnail URL: content-type "${declared || "none"}" is not ` +
                `one of ${ACCEPTED_IMAGE_TYPES.join(", ")}`
            )
          );
        }

        const chunks = [];
        let received = 0;

        response.on("data", (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            // Abort mid-stream rather than trusting Content-Length.
            response.destroy();
            request.destroy();
            reject(
              new MediaError(
                `Blocked thumbnail URL: image exceeds the ${maxBytes} byte limit`
              )
            );
            return;
          }
          chunks.push(chunk);
        });

        response.on("end", () => resolve({ body: Buffer.concat(chunks), declared }));
        response.on("error", (error) =>
          reject(new MediaError(`Thumbnail download failed: ${error.message}`))
        );
      }
    );

    request.on("timeout", () => {
      request.destroy(new MediaError("Blocked thumbnail URL: request timed out"));
    });
    request.on("error", (error) => {
      reject(
        error instanceof MediaError
          ? error
          : new MediaError(
              `Thumbnail download failed for ${redactUrl(url)}: ${error.message}`
            )
      );
    });
    request.end();
  });
}

/**
 * Fetch a thumbnail over HTTPS with every restriction re-applied at each hop.
 *
 * @returns {Promise<{buffer: Buffer, mimeType: string, source: string}>}
 */
export async function fetchThumbnailUrl(config, rawUrl, options = {}) {
  const now = options.now ?? Date.now;
  // A bound on TOTAL elapsed time, not just per-socket inactivity: a server
  // that trickles one byte per second must not hold the request open forever.
  const deadline = now() + TOTAL_TIMEOUT_MS;
  const maxBytes = config.thumbnailMaxBytes;

  let current = assertSafeUrl(rawUrl, config).toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await requestOnce(current, {
      deadline,
      maxBytes,
      signal: options.signal,
      requestFn: options.requestFn,
      now,
    });

    if (result.redirectTo) {
      if (hop === MAX_REDIRECTS) {
        throw new MediaError(
          `Blocked thumbnail URL: more than ${MAX_REDIRECTS} redirects`
        );
      }
      // Re-apply EVERY restriction to the new target, including the IP-literal
      // and allowlist checks - a redirect must not be a way around them.
      current = assertSafeUrl(result.redirectTo, config).toString();
      continue;
    }

    const sniffed = sniffImage(result.body);
    if (!sniffed) {
      throw new MediaError(
        "Blocked thumbnail URL: downloaded bytes are not a valid JPEG or PNG " +
          `(server claimed ${result.declared})`
      );
    }

    return { buffer: result.body, mimeType: sniffed, source: redactUrl(current) };
  }

  throw new MediaError("Blocked thumbnail URL: redirect handling failed");
}

/**
 * Resolve a thumbnail from the configured media directory.
 *
 * Canonicalises both the directory and the candidate, then requires the
 * candidate to sit inside the directory. Because both sides are real paths,
 * this defeats `../`, absolute paths, symlink escapes, and the "/media-evil"
 * sibling-prefix trick in one check.
 *
 * @returns {Promise<{buffer: Buffer, mimeType: string, source: string}>}
 */
export async function resolveThumbnailPath(config, imagePath) {
  if (!config.mediaDir) {
    throw new MediaError(
      "imagePath is unavailable: YOUTUBE_MEDIA_DIR is not configured. Set it " +
        "to the directory thumbnails may be read from, or use imageUrl."
    );
  }

  let mediaReal;
  try {
    mediaReal = await fs.realpath(config.mediaDir);
  } catch {
    throw new MediaError(
      `imagePath is unavailable: YOUTUBE_MEDIA_DIR (${config.mediaDir}) does not exist`
    );
  }

  const candidate = path.resolve(mediaReal, imagePath);

  let candidateReal;
  try {
    candidateReal = await fs.realpath(candidate);
  } catch {
    throw new MediaError(
      `Thumbnail not found inside the configured media directory: ${imagePath}`
    );
  }

  if (!isInside(mediaReal, candidateReal)) {
    throw new MediaError(
      `Blocked thumbnail path: ${imagePath} resolves outside the configured media directory`
    );
  }

  const stats = await fs.stat(candidateReal);
  if (!stats.isFile()) {
    throw new MediaError(`Blocked thumbnail path: ${imagePath} is not a regular file`);
  }
  if (stats.size > config.thumbnailMaxBytes) {
    throw new MediaError(
      `Blocked thumbnail path: ${imagePath} is ${stats.size} bytes, over the ` +
        `${config.thumbnailMaxBytes} byte limit`
    );
  }

  const buffer = await fs.readFile(candidateReal);
  const mimeType = sniffImage(buffer);
  if (!mimeType) {
    throw new MediaError(
      `Blocked thumbnail path: ${imagePath} is not a valid JPEG or PNG`
    );
  }

  return {
    buffer,
    mimeType,
    source: path.relative(mediaReal, candidateReal) || path.basename(candidateReal),
  };
}
