/**
 * Stable absolute paths.
 *
 * Every state file lives next to package.json, never next to process.cwd().
 * Process managers (pm2, systemd) start the agent from arbitrary directories,
 * and a relative path there silently creates a second, empty ledger.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(start) {
  let dir = start;
  for (let hop = 0; hop < 8; hop += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export const ROOT = findRoot(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** Absolute path inside the project root. */
export function rootPath(...segments) {
  return path.join(ROOT, ...segments);
}

/**
 * Absolute path inside the project's gitignored data directory.
 *
 * AETERNUM_DATA_DIR redirects it, which is how the test suite runs against a
 * scratch ledger instead of the operator's real positions.
 */
export function dataPath(...segments) {
  const dir = process.env.AETERNUM_DATA_DIR || path.join(ROOT, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, ...segments);
}
