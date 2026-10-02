/**
 * Tagged console logging with an optional rolling file sink.
 *
 * Tags ending in `_error` print to stderr; tags ending in `_warn` are dimmed.
 * Set LOG_FILE to mirror everything into a file (pm2 already captures stdout,
 * so this is only useful for bare `node index.js` runs).
 */

import fs from "node:fs";

const COLORS = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
};

const TAG_COLORS = {
  agent: COLORS.magenta,
  chain: COLORS.cyan,
  screen: COLORS.green,
  manage: COLORS.green,
  telegram: COLORS.cyan,
  hivemind: COLORS.magenta,
  watcher: COLORS.dim,
};

const LOG_FILE = process.env.LOG_FILE || null;
let quiet = false;
let forceStderr = false;

/** Suppress log output entirely (used by the test runner). */
export function setQuiet(value) {
  quiet = !!value;
}

/**
 * Send every log line to stderr instead of stdout.
 *
 * The CLI prints machine-readable JSON on stdout, so a single log line written
 * there makes the output unparseable. Diverting rather than suppressing keeps the
 * progress visible in a terminal while `| jq` still works.
 */
export function setLogStream(stream) {
  forceStderr = stream === "stderr";
}

export function log(tag, message) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${stamp}] [${tag}] ${message}`;

  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, `${line}\n`);
    } catch {
      /* a broken log sink must never take the agent down */
    }
  }
  if (quiet) return;

  const isError = tag.endsWith("_error");
  const isWarn = tag.endsWith("_warn");
  const color = isError ? COLORS.red : isWarn ? COLORS.yellow : TAG_COLORS[tag] || COLORS.reset;
  const stream = isError || forceStderr ? process.stderr : process.stdout;
  stream.write(`${COLORS.dim}[${stamp}]${COLORS.reset} ${color}[${tag}]${COLORS.reset} ${message}\n`);
}

export function logError(tag, error) {
  log(`${tag}_error`, error?.stack || error?.message || String(error));
}
