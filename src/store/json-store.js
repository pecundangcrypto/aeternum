/**
 * Crash-safe JSON persistence for the agent's ledgers.
 *
 * Writes go to a sibling temp file and are renamed into place, so a kill
 * mid-write can never leave a half-written positions ledger behind — the
 * agent would otherwise lose track of live on-chain capital.
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed ?? structuredClone(fallback);
  } catch (err) {
    log("store_warn", `${path.basename(file)} unreadable (${err.message}) — using defaults`);
    return structuredClone(fallback);
  }
}

export function writeJson(file, value) {
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temp, file);
    return true;
  } catch (err) {
    log("store_error", `Failed to write ${path.basename(file)}: ${err.message}`);
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* temp cleanup is best effort */
    }
    return false;
  }
}

/**
 * A named JSON file with a fixed default shape.
 * `update` reads, mutates via the callback, and persists in one step.
 */
export function createStore(file, defaults) {
  return {
    file,
    read: () => readJson(file, defaults),
    write: (value) => writeJson(file, value),
    update(mutate) {
      const state = readJson(file, defaults);
      const result = mutate(state);
      writeJson(file, state);
      return result;
    },
  };
}

/** Keep the newest `max` entries of an append-only list. */
export function trimList(list, max) {
  if (!Array.isArray(list)) return [];
  return list.length > max ? list.slice(list.length - max) : list;
}
