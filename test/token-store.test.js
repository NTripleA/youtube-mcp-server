import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { TokenStore, grantedScopes, mergeCredentials } from "../src/auth.js";
import { tempDir } from "./helpers.js";

async function store() {
  const dir = await tempDir("yt-mcp-token-");
  const file = path.join(dir, "nested", "token.json");
  return {
    dir,
    file,
    store: new TokenStore(file),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

// -- merge semantics --------------------------------------------------------

test("a refresh response without refresh_token preserves the stored one", () => {
  const merged = mergeCredentials(
    { access_token: "old", refresh_token: "KEEP-ME", scope: "a b" },
    { access_token: "new", expiry_date: 123 }
  );

  assert.equal(merged.refresh_token, "KEEP-ME");
  assert.equal(merged.access_token, "new");
  assert.equal(merged.expiry_date, 123);
  assert.equal(merged.scope, "a b");
});

test("a genuinely supplied refresh token replaces the stored one", () => {
  const merged = mergeCredentials(
    { refresh_token: "OLD" },
    { refresh_token: "NEW", access_token: "a" }
  );

  assert.equal(merged.refresh_token, "NEW");
});

test("merging onto nothing just keeps the update", () => {
  const merged = mergeCredentials(null, { access_token: "a", refresh_token: "r" });
  assert.deepEqual(merged, { access_token: "a", refresh_token: "r" });
});

// -- the regression that kills a deployment a week after setup --------------

test("credentials survive: initial -> refresh without refresh_token -> reload", async () => {
  const s = await store();
  try {
    // 1. Initial provisioning, the only time Google sends a refresh token.
    await s.store.save({
      access_token: "access-1",
      refresh_token: "REFRESH-TOKEN-FROM-CONSENT",
      scope: "https://www.googleapis.com/auth/youtube.force-ssl",
      expiry_date: 1000,
    });

    // 2. An hour later the access token is refreshed. Google omits the refresh
    //    token. Writing this response verbatim is what destroys the deployment.
    await s.store.save({ access_token: "access-2", expiry_date: 2000 });

    // 3. Restart: a brand-new store reads the file from scratch.
    const reloaded = await new TokenStore(s.file).load();

    assert.equal(reloaded.refresh_token, "REFRESH-TOKEN-FROM-CONSENT");
    assert.equal(reloaded.access_token, "access-2");
    assert.equal(reloaded.expiry_date, 2000);
    assert.equal(
      reloaded.scope,
      "https://www.googleapis.com/auth/youtube.force-ssl"
    );
  } finally {
    await s.cleanup();
  }
});

test("repeated refreshes never erode the refresh token", async () => {
  const s = await store();
  try {
    await s.store.save({ access_token: "a0", refresh_token: "R" });
    for (let i = 1; i <= 5; i += 1) {
      await s.store.save({ access_token: `a${i}` });
    }
    const reloaded = await new TokenStore(s.file).load();
    assert.equal(reloaded.refresh_token, "R");
    assert.equal(reloaded.access_token, "a5");
  } finally {
    await s.cleanup();
  }
});

test("concurrent writes are serialized and none is lost", async () => {
  const s = await store();
  try {
    await s.store.save({ refresh_token: "R", access_token: "initial" });

    await Promise.all([
      s.store.save({ access_token: "a" }),
      s.store.save({ expiry_date: 1 }),
      s.store.save({ token_type: "Bearer" }),
    ]);

    const reloaded = await new TokenStore(s.file).load();
    assert.equal(reloaded.refresh_token, "R");
    assert.equal(reloaded.expiry_date, 1);
    assert.equal(reloaded.token_type, "Bearer");
  } finally {
    await s.cleanup();
  }
});

// -- on-disk properties -----------------------------------------------------

test("the token file is 0600 and its directory 0700", async () => {
  const s = await store();
  try {
    await s.store.save({ access_token: "a", refresh_token: "r" });

    const fileMode = (await fs.stat(s.file)).mode & 0o777;
    const dirMode = (await fs.stat(path.dirname(s.file))).mode & 0o777;

    assert.equal(fileMode, 0o600, `file mode was ${fileMode.toString(8)}`);
    assert.equal(dirMode, 0o700, `dir mode was ${dirMode.toString(8)}`);
  } finally {
    await s.cleanup();
  }
});

test("writes leave no temporary files behind", async () => {
  const s = await store();
  try {
    await s.store.save({ access_token: "a" });
    await s.store.save({ access_token: "b" });

    const entries = await fs.readdir(path.dirname(s.file));
    assert.deepEqual(entries, ["token.json"]);
  } finally {
    await s.cleanup();
  }
});

test("a missing token file loads as null rather than throwing", async () => {
  const s = await store();
  try {
    assert.equal(await s.store.load(), null);
    assert.equal(await s.store.exists(), false);
  } finally {
    await s.cleanup();
  }
});

test("a corrupt token file reports clearly instead of crashing", async () => {
  const s = await store();
  try {
    await fs.mkdir(path.dirname(s.file), { recursive: true });
    await fs.writeFile(s.file, "{ not json");
    await assert.rejects(() => s.store.load(), /not valid JSON/);
  } finally {
    await s.cleanup();
  }
});

// -- granted scopes ---------------------------------------------------------

test("granted scopes come from the token", () => {
  assert.deepEqual(grantedScopes({ scope: "a b  c" }), ["a", "b", "c"]);
});

test('an absent scope field is reported as "unknown", never as the requested list', () => {
  assert.equal(grantedScopes({ access_token: "a" }), "unknown");
  assert.equal(grantedScopes({ scope: "" }), "unknown");
  assert.equal(grantedScopes(null), "unknown");
});
