import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveThumbnailPath, sniffImage } from "../src/media.js";
import { JPEG_BYTES, PNG_BYTES, tempDir, testConfig } from "./helpers.js";

/**
 * Layout used by these tests:
 *   <root>/media/ok.jpg
 *   <root>/media/nested/deep.png
 *   <root>/media/link-out      -> <root>/outside/secret.jpg   (symlink)
 *   <root>/outside/secret.jpg
 *   <root>/media-evil/evil.jpg                (sibling prefix trick)
 */
async function fixture() {
  const root = await tempDir();
  const media = path.join(root, "media");
  const outside = path.join(root, "outside");
  const evil = path.join(root, "media-evil");

  await fs.mkdir(path.join(media, "nested"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(evil, { recursive: true });

  await fs.writeFile(path.join(media, "ok.jpg"), JPEG_BYTES);
  await fs.writeFile(path.join(media, "nested", "deep.png"), PNG_BYTES);
  await fs.writeFile(path.join(outside, "secret.jpg"), JPEG_BYTES);
  await fs.writeFile(path.join(evil, "evil.jpg"), JPEG_BYTES);
  await fs.symlink(path.join(outside, "secret.jpg"), path.join(media, "link-out"));

  const config = testConfig({ YOUTUBE_MEDIA_DIR: media });
  return { root, media, outside, evil, config, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("sniffImage identifies real JPEG and PNG bytes", () => {
  assert.equal(sniffImage(JPEG_BYTES), "image/jpeg");
  assert.equal(sniffImage(PNG_BYTES), "image/png");
  assert.equal(sniffImage(Buffer.from("GIF89a-not-supported-here")), null);
  assert.equal(sniffImage(Buffer.alloc(2)), null);
});

test("a legitimate nested path inside the media dir is accepted", async () => {
  const f = await fixture();
  try {
    const image = await resolveThumbnailPath(f.config, "nested/deep.png");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.source, path.join("nested", "deep.png"));
  } finally {
    await f.cleanup();
  }
});

test("traversal with ../ is rejected", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => resolveThumbnailPath(f.config, "../outside/secret.jpg"),
      /outside the configured media directory|not found inside/
    );
  } finally {
    await f.cleanup();
  }
});

test("a deeply nested traversal is rejected", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => resolveThumbnailPath(f.config, "nested/../../outside/secret.jpg"),
      /outside the configured media directory|not found inside/
    );
  } finally {
    await f.cleanup();
  }
});

test("an absolute path outside the media dir is rejected", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => resolveThumbnailPath(f.config, path.join(f.outside, "secret.jpg")),
      /outside the configured media directory/
    );
  } finally {
    await f.cleanup();
  }
});

test("a symlink pointing outside the media dir is rejected", async () => {
  const f = await fixture();
  try {
    // The file IS inside the directory; only canonicalisation reveals the escape.
    await assert.rejects(
      () => resolveThumbnailPath(f.config, "link-out"),
      /outside the configured media directory/
    );
  } finally {
    await f.cleanup();
  }
});

test("a sibling directory sharing the media dir's prefix is rejected", async () => {
  const f = await fixture();
  try {
    // "/tmp/x/media-evil" starts with "/tmp/x/media" as a STRING but is not
    // inside it as a PATH. A naive startsWith check would let this through.
    await assert.rejects(
      () => resolveThumbnailPath(f.config, path.join(f.evil, "evil.jpg")),
      /outside the configured media directory/
    );
  } finally {
    await f.cleanup();
  }
});

test("a non-existent file is rejected without leaking whether it is outside", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => resolveThumbnailPath(f.config, "no-such-file.jpg"),
      /not found inside the configured media directory/
    );
  } finally {
    await f.cleanup();
  }
});

test("a directory is rejected as not a regular file", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => resolveThumbnailPath(f.config, "nested"),
      /not a regular file/
    );
  } finally {
    await f.cleanup();
  }
});

test("a file over the size limit is rejected before it is read", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.media, "big.jpg"), Buffer.alloc(5000, 0x20));
    const config = testConfig({
      YOUTUBE_MEDIA_DIR: f.media,
      YOUTUBE_THUMBNAIL_MAX_BYTES: "1024",
    });
    await assert.rejects(
      () => resolveThumbnailPath(config, "big.jpg"),
      /over the 1024 byte limit/
    );
  } finally {
    await f.cleanup();
  }
});

test("a file whose bytes are not a real image is rejected", async () => {
  const f = await fixture();
  try {
    // Named .jpg, contents are not a JPEG. The extension is not the check.
    await fs.writeFile(
      path.join(f.media, "fake.jpg"),
      Buffer.from("#!/bin/sh\necho definitely not an image\n")
    );
    await assert.rejects(
      () => resolveThumbnailPath(f.config, "fake.jpg"),
      /not a valid JPEG or PNG/
    );
  } finally {
    await f.cleanup();
  }
});

test("imagePath is unavailable when no media dir is configured", async () => {
  const config = testConfig({});
  assert.equal(config.mediaDir, null);
  await assert.rejects(
    () => resolveThumbnailPath(config, "anything.jpg"),
    /YOUTUBE_MEDIA_DIR is not configured/
  );
});

test("remote mode defaults the media dir to /media", () => {
  const config = testConfig({ MCP_TRANSPORT: "http" });
  assert.equal(config.mediaDir, "/media");
});

test("a media dir that does not exist yields a clear message", async () => {
  const config = testConfig({ YOUTUBE_MEDIA_DIR: "/nonexistent-media-dir-xyz" });
  await assert.rejects(
    () => resolveThumbnailPath(config, "x.jpg"),
    /does not exist/
  );
});
