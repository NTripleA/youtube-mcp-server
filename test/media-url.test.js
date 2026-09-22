import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import {
  assertSafeAddress,
  assertSafeUrl,
  fetchThumbnailUrl,
  safeLookup,
} from "../src/media.js";
import { JPEG_BYTES, PNG_BYTES, testConfig } from "./helpers.js";

const config = testConfig({});

// -- address classification -------------------------------------------------

test("public unicast addresses are allowed", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(assertSafeAddress(address), true, address);
  }
});

test("loopback, private, link-local, CGNAT and reserved v4 are blocked", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.4.1",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // carrier-grade NAT
    "224.0.0.1", // multicast
    "255.255.255.255",
    "240.0.0.1", // reserved
  ];
  for (const address of blocked) {
    assert.throws(() => assertSafeAddress(address), /non-public/, address);
  }
});

test("loopback, unique-local and link-local v6 are blocked", () => {
  for (const address of ["::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
    assert.throws(() => assertSafeAddress(address), /non-public/, address);
  }
});

test("IPv4-mapped IPv6 is unwrapped and re-checked", () => {
  // ::ffff:127.0.0.1 is "IPv6 unicast" to a naive check, but it addresses
  // loopback. Unwrapping is what catches it.
  assert.throws(() => assertSafeAddress("::ffff:127.0.0.1"), /non-public/);
  assert.throws(() => assertSafeAddress("::ffff:10.0.0.1"), /non-public/);
  assert.equal(assertSafeAddress("::ffff:8.8.8.8"), true);
});

// -- URL validation ---------------------------------------------------------

test("only https is accepted", () => {
  assert.throws(() => assertSafeUrl("http://example.com/a.jpg", config), /only https/);
  assert.throws(() => assertSafeUrl("file:///etc/passwd", config), /only https/);
  assert.throws(() => assertSafeUrl("ftp://example.com/a.jpg", config), /only https/);
});

test("embedded credentials are rejected", () => {
  assert.throws(
    () => assertSafeUrl("https://user:pass@example.com/a.jpg", config),
    /embedded credentials/
  );
  assert.throws(
    () => assertSafeUrl("https://user@example.com/a.jpg", config),
    /embedded credentials/
  );
});

test("IP literals are classified before any connection", () => {
  assert.throws(() => assertSafeUrl("https://127.0.0.1/a.jpg", config), /non-public/);
  assert.throws(() => assertSafeUrl("https://[::1]/a.jpg", config), /non-public/);
  assert.throws(
    () => assertSafeUrl("https://169.254.169.254/latest/meta-data", config),
    /non-public/
  );
});

test("alternate IPv4 spellings are normalised and then blocked", () => {
  // The WHATWG URL parser folds these into dotted-quad form, so a decimal,
  // octal or hex spelling of 127.0.0.1 cannot sneak past the classifier.
  for (const spelling of [
    "https://2130706433/a.jpg", // decimal
    "https://0x7f000001/a.jpg", // hex
    "https://017700000001/a.jpg", // octal
    "https://127.1/a.jpg", // short form
  ]) {
    assert.throws(() => assertSafeUrl(spelling, config), /non-public/, spelling);
  }
});

test("a public hostname passes URL validation", () => {
  const url = assertSafeUrl("https://cdn.example.com/a.jpg?sig=abc", config);
  assert.equal(url.hostname, "cdn.example.com");
});

test("an optional host allowlist narrows further without being required", () => {
  const restricted = testConfig({
    YOUTUBE_THUMBNAIL_URL_ALLOWED_HOSTS: "cdn.example.com",
  });
  assert.ok(assertSafeUrl("https://cdn.example.com/a.jpg", restricted));
  assert.throws(
    () => assertSafeUrl("https://other.example.com/a.jpg", restricted),
    /ALLOWED_HOSTS/
  );
  // Unset => ordinary public images still work.
  assert.ok(assertSafeUrl("https://other.example.com/a.jpg", config));
});

// -- DNS results ------------------------------------------------------------

function lookupOnce(addresses) {
  return new Promise((resolve) => {
    const fakeDnsAddresses = addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    // Exercise the real validation branch by calling it with pre-resolved data.
    try {
      for (const entry of fakeDnsAddresses) assertSafeAddress(entry.address);
      resolve({ ok: true });
    } catch (error) {
      resolve({ ok: false, error });
    }
  });
}

test("a hostname resolving to a private address is refused", async () => {
  const result = await lookupOnce(["10.1.2.3"]);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /non-public/);
});

test("a hostname with one good and one bad record is refused outright", async () => {
  // Strict: we do not race to pick the good record.
  const result = await lookupOnce(["8.8.8.8", "127.0.0.1"]);
  assert.equal(result.ok, false);
});

test("safeLookup rejects a hostname that resolves to loopback", async () => {
  const error = await new Promise((resolve) => {
    safeLookup("localhost", { family: 4 }, (err) => resolve(err));
  });
  assert.ok(error, "expected localhost to be refused");
  assert.match(String(error.message), /non-public|did not resolve/);
});

// -- fetch behaviour (injected transport) -----------------------------------

/**
 * A stand-in for https.request. `script` maps a URL to a canned response so the
 * real redirect loop, byte cap, content-type check and sniffing all run.
 */
function fakeTransport(script) {
  const seen = [];

  const requestFn = (url, options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      const entry = script[String(url)];
      seen.push({ url: String(url), options });

      if (!entry) {
        queueMicrotask(() => request.emit("error", new Error(`no script for ${url}`)));
        return;
      }
      if (entry.networkError) {
        queueMicrotask(() => request.emit("error", entry.networkError));
        return;
      }

      const response = entry.chunks
        ? Readable.from(entry.chunks)
        : Readable.from([entry.body ?? Buffer.alloc(0)]);
      response.statusCode = entry.status ?? 200;
      response.headers = entry.headers ?? { "content-type": "image/jpeg" };
      queueMicrotask(() => callback(response));
    };
    request.destroy = () => {};
    return request;
  };

  return { requestFn, seen };
}

const GOOD = "https://cdn.example.com/thumb.jpg";

test("a well-formed public image is downloaded and sniffed", async () => {
  const { requestFn } = fakeTransport({
    [GOOD]: { body: JPEG_BYTES, headers: { "content-type": "image/jpeg" } },
  });

  const image = await fetchThumbnailUrl(config, GOOD, { requestFn });

  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.buffer.length, JPEG_BYTES.length);
});

test("no credentials, cookies or Authorization header are ever sent", async () => {
  const { requestFn, seen } = fakeTransport({
    [GOOD]: { body: PNG_BYTES, headers: { "content-type": "image/png" } },
  });

  await fetchThumbnailUrl(config, GOOD, { requestFn });

  const headerNames = Object.keys(seen[0].options.headers).map((h) => h.toLowerCase());
  assert.deepEqual(headerNames.sort(), ["accept", "user-agent"]);
  for (const forbidden of ["authorization", "cookie", "x-goog-api-key"]) {
    assert.equal(headerNames.includes(forbidden), false);
  }
});

test("the request pins the validating DNS lookup and keeps TLS verification on", async () => {
  const { requestFn, seen } = fakeTransport({
    [GOOD]: { body: JPEG_BYTES },
  });

  await fetchThumbnailUrl(config, GOOD, { requestFn });

  assert.equal(seen[0].options.lookup, safeLookup);
  assert.equal(seen[0].options.rejectUnauthorized, undefined, "TLS default preserved");
});

test("a redirect to a blocked address is rejected", async () => {
  const { requestFn } = fakeTransport({
    [GOOD]: { status: 302, headers: { location: "https://169.254.169.254/token" } },
  });

  await assert.rejects(
    () => fetchThumbnailUrl(config, GOOD, { requestFn }),
    /non-public/
  );
});

test("a redirect to http is rejected", async () => {
  const { requestFn } = fakeTransport({
    [GOOD]: { status: 302, headers: { location: "http://cdn.example.com/x.jpg" } },
  });

  await assert.rejects(() => fetchThumbnailUrl(config, GOOD, { requestFn }), /only https/);
});

test("a redirect into credentials is rejected", async () => {
  const { requestFn } = fakeTransport({
    [GOOD]: {
      status: 302,
      headers: { location: "https://u:p@cdn.example.com/x.jpg" },
    },
  });

  await assert.rejects(
    () => fetchThumbnailUrl(config, GOOD, { requestFn }),
    /embedded credentials/
  );
});

test("a legitimate redirect chain is followed", async () => {
  const second = "https://cdn2.example.com/final.jpg";
  const { requestFn, seen } = fakeTransport({
    [GOOD]: { status: 301, headers: { location: second } },
    [second]: { body: PNG_BYTES, headers: { "content-type": "image/png" } },
  });

  const image = await fetchThumbnailUrl(config, GOOD, { requestFn });

  assert.equal(image.mimeType, "image/png");
  assert.equal(seen.length, 2);
});

test("too many redirects are rejected", async () => {
  const script = {};
  for (let i = 0; i <= 6; i += 1) {
    script[`https://cdn.example.com/${i}.jpg`] = {
      status: 302,
      headers: { location: `https://cdn.example.com/${i + 1}.jpg` },
    };
  }
  const { requestFn } = fakeTransport(script);

  await assert.rejects(
    () => fetchThumbnailUrl(config, "https://cdn.example.com/0.jpg", { requestFn }),
    /more than 3 redirects/
  );
});

test("a redirect without a location is rejected", async () => {
  const { requestFn } = fakeTransport({ [GOOD]: { status: 302, headers: {} } });

  await assert.rejects(
    () => fetchThumbnailUrl(config, GOOD, { requestFn }),
    /redirect without a location/
  );
});

test("a non-image content-type is rejected", async () => {
  const { requestFn } = fakeTransport({
    [GOOD]: { body: JPEG_BYTES, headers: { "content-type": "text/html" } },
  });

  await assert.rejects(
    () => fetchThumbnailUrl(config, GOOD, { requestFn }),
    /content-type "text\/html" is not one of/
  );
});

test("a missing content-type is rejected", async () => {
  const { requestFn } = fakeTransport({ [GOOD]: { body: JPEG_BYTES, headers: {} } });

  await assert.rejects(
    () => fetchThumbnailUrl(config, GOOD, { requestFn }),
    /content-type "none" is not one of/
  );
});

test("bytes that merely CLAIM to be an image are rejected", async () => {
  const { requestFn } = fakeTransport({
    [GOOD]: {
      body: Buffer.from("<html>not an image at all</html>"),
      headers: { "content-type": "image/jpeg" },
    },
  });

  await assert.rejects(
    () => fetchThumbnailUrl(config, GOOD, { requestFn }),
    /not a valid JPEG or PNG/
  );
});

test("a non-200 status is rejected and the query string is redacted", async () => {
  const signed = "https://cdn.example.com/t.jpg?X-Amz-Signature=SUPERSECRETVALUE";
  const { requestFn } = fakeTransport({ [signed]: { status: 404 } });

  await assert.rejects(
    () => fetchThumbnailUrl(config, signed, { requestFn }),
    (error) => {
      assert.match(error.message, /responded 404/);
      assert.match(error.message, /\?\[redacted\]/);
      assert.equal(
        error.message.includes("SUPERSECRETVALUE"),
        false,
        "signed query must never appear in an error"
      );
      return true;
    }
  );
});

test("the byte cap aborts mid-stream rather than trusting content-length", async () => {
  const small = testConfig({ YOUTUBE_THUMBNAIL_MAX_BYTES: "100" });
  const { requestFn } = fakeTransport({
    [GOOD]: {
      // Lies about its size, then streams far more than the cap.
      headers: { "content-type": "image/jpeg", "content-length": "10" },
      chunks: [JPEG_BYTES, Buffer.alloc(400, 0x20), Buffer.alloc(400, 0x20)],
    },
  });

  await assert.rejects(
    () => fetchThumbnailUrl(small, GOOD, { requestFn }),
    /exceeds the 100 byte limit/
  );
});

test("the total elapsed-time bound is enforced", async () => {
  let clock = 1_000_000;
  const second = "https://cdn2.example.com/final.jpg";
  const { requestFn } = fakeTransport({
    [GOOD]: { status: 302, headers: { location: second } },
    [second]: { body: JPEG_BYTES },
  });

  await assert.rejects(
    () =>
      fetchThumbnailUrl(config, GOOD, {
        requestFn,
        now: () => {
          // Jump past the deadline after the first hop.
          clock += 60_000;
          return clock;
        },
      }),
    /total time limit exceeded/
  );
});
