#!/usr/bin/env node
/**
 * Lightweight repo check: parse every source file. There is no linter
 * configured in this project, so this is the "does it even parse" gate that
 * `npm run check` provides for CI and for the Docker build.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(["node_modules", ".git", "state", "media"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

let failures = 0;
let checked = 0;

for await (const file of walk(root)) {
  checked += 1;
  try {
    await run(process.execPath, ["--check", file]);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${path.relative(root, file)}`);
    console.error(error.stderr?.trim() ?? error.message);
  }
}

console.log(`checked ${checked} file(s), ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
