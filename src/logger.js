/**
 * Logging that is safe to leave enabled on a remote deployment.
 *
 * Two rules drive everything here:
 *   1. Nothing token-shaped or secret-shaped ever reaches stderr.
 *   2. Google API errors are reduced to a short, structured summary. Raw gaxios
 *      errors carry `config.headers.Authorization` and the full request body,
 *      so they are never stringified whole.
 */

/** Literal secret values registered at startup, masked wherever they appear. */
const registeredSecrets = new Set();

/**
 * Register a literal secret (client secret, API key, ...) so `redact` masks it
 * even when it shows up inside a message we did not construct.
 */
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) {
    registeredSecrets.add(value);
  }
}

/** Test seam. */
export function clearRegisteredSecrets() {
  registeredSecrets.clear();
}

// Patterns for credential material that we may never have seen as a literal:
// Google access tokens (ya29.*), refresh tokens (1//*), OAuth client secrets
// (GOCSPX-*), JWTs, and any explicit token-ish key in a JSON blob.
const TOKEN_PATTERNS = [
  /ya29\.[A-Za-z0-9._\-]+/g,
  /1\/\/[A-Za-z0-9._\-]{10,}/g,
  /GOCSPX-[A-Za-z0-9._\-]+/g,
  /eyJ[A-Za-z0-9._\-]{10,}/g,
];

/**
 * Credential-bearing keys in JSON or key=value text, whatever the value looks
 * like. The optional quote before the separator is what makes this match JSON's
 * `"refresh_token": "..."` as well as a bare `refresh_token=...`.
 */
const KEYED_SECRET_PATTERN =
  /\b(access_token|refresh_token|id_token|client_secret|authorization|api[_-]?key)\b(["']?\s*[:=]\s*)(["']?)([^\s,"'}&]+)\3/gi;

/**
 * Mask secrets in an arbitrary string. Safe to call on anything, including
 * strings that contain no secrets.
 */
export function redact(input) {
  if (input === null || input === undefined) return input;
  let text = typeof input === "string" ? input : String(input);

  for (const secret of registeredSecrets) {
    if (secret && text.includes(secret)) {
      text = text.split(secret).join("[redacted]");
    }
  }

  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }

  text = text.replace(
    KEYED_SECRET_PATTERN,
    (_match, key, separator, quote) => `${key}${separator}${quote}[redacted]${quote}`
  );

  return text;
}

/**
 * Strip the query string from a URL for logging. Signed URLs carry their
 * credential in the query, so errors mentioning a URL must never include it.
 */
export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    const query = url.search ? "?[redacted]" : "";
    return `${url.origin}${url.pathname}${query}`;
  } catch {
    return "[unparseable url]";
  }
}

/**
 * Reduce any error - especially a gaxios/googleapis error - to a short safe
 * string. Deliberately never touches `error.config` or `error.response.headers`.
 */
export function sanitizeGoogleError(error) {
  if (!error) return "unknown error";

  const parts = [];
  const message = typeof error.message === "string" ? error.message : String(error);
  parts.push(message);

  const status = error.status ?? error.code ?? error.response?.status;
  if (status !== undefined && !message.includes(String(status))) {
    parts.push(`(status ${status})`);
  }

  // googleapis puts per-error reasons here; they are descriptive, not sensitive.
  const reasons = error.errors?.map?.((e) => e?.reason).filter(Boolean);
  if (reasons?.length) {
    parts.push(`[${reasons.join(", ")}]`);
  }

  return redact(parts.join(" "));
}

/**
 * True when an error represents "we could not reach/complete the call", as
 * opposed to a definitive answer from Google. Drives the channel lock's
 * UNVERIFIED state: a transient outage must never look like a mismatch, and
 * must never look like success either.
 */
export function isTransientError(error) {
  if (!error) return false;

  const status = Number(error.status ?? error.response?.status ?? NaN);
  if (Number.isFinite(status)) {
    // 5xx, 429 (quota/rate), 408 (timeout) are retryable; 4xx otherwise is a
    // definitive answer.
    if (status >= 500) return true;
    if (status === 429 || status === 408) return true;
    return false;
  }

  const code = String(error.code ?? "");
  const transientCodes = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "ERR_SOCKET_CONNECTION_TIMEOUT",
    "ABORT_ERR",
  ];
  if (transientCodes.includes(code)) return true;

  // No response at all from gaxios means the request never completed.
  if (error.response === undefined && error.config !== undefined) return true;

  return false;
}

/**
 * stderr logger. stdout is reserved for the stdio JSON-RPC stream, so
 * everything goes to stderr in both transports.
 */
export function createLogger({ stream = process.stderr, prefix = "youtube-mcp" } = {}) {
  const write = (level, args) => {
    const line = args
      .map((a) => (typeof a === "string" ? a : safeInspect(a)))
      .join(" ");
    stream.write(`[${prefix}] ${level}: ${redact(line)}\n`);
  };

  return {
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

function safeInspect(value) {
  if (value instanceof Error) return sanitizeGoogleError(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[uninspectable]";
  }
}
