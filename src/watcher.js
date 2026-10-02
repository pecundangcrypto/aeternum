/**
 * The fast loop.
 *
 * Trailing take-profit is only as good as the sampling rate behind it. A ten
 * minute cron gives back ten minutes of a reversal; this loop values every
 * position every `watcherIntervalSec` and applies the exit rules directly,
 * without a model in the path.
 *
 * It is the reason `confirmTicks` exists: at a 20 second cadence, two confirming
 * reads cost 20-40 seconds and filter the single bad RPC read that would
 * otherwise inflate a peak and immediately trip the stop.
 */

import { config } from "./config.js";
import { log, logError } from "./logger.js";
import { sweepExits } from "./cycles/manage.js";
import { listOpen } from "./store/positions.js";

let timer = null;
let running = false;
let paused = false;
let stats = { ticks: 0, closes: 0, harvests: 0, errors: 0, lastTickAt: null };

async function tick() {
  // Overlap would double-evaluate the exit rules and could double-submit a close.
  if (running || paused) return;
  if (!listOpen().length) return;

  running = true;
  try {
    const actions = await sweepExits({ fast: true, actor: "watcher" });
    stats.ticks += 1;
    stats.closes += actions.filter((action) => action.kind === "close").length;
    stats.harvests += actions.filter((action) => action.kind === "harvest").length;
    stats.lastTickAt = new Date().toISOString();
  } catch (err) {
    stats.errors += 1;
    logError("watcher", err);
  } finally {
    running = false;
  }
}

export function start() {
  if (timer) return { started: false, reason: "already running" };
  if (!config.schedule.watcherEnabled) {
    log("watcher", "Disabled — trailing take-profit will only be evaluated on the management cron");
    return { started: false, reason: "disabled in config" };
  }

  const intervalMs = Math.max(5, config.schedule.watcherIntervalSec) * 1_000;
  timer = setInterval(() => {
    tick().catch((err) => logError("watcher", err));
  }, intervalMs);
  timer.unref?.();

  log("watcher", `Watching positions every ${config.schedule.watcherIntervalSec}s (confirm ${config.management.confirmTicks} ticks before acting)`);
  return { started: true, intervalSec: config.schedule.watcherIntervalSec };
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  return { stopped: true };
}

/** Pause exits without tearing the loop down — used by the Telegram `/pause`. */
export function pause() {
  paused = true;
  log("watcher", "Paused — exit rules will not fire until resumed");
  return { paused: true };
}

export function resume() {
  paused = false;
  log("watcher", "Resumed");
  return { paused: false };
}

export function isPaused() {
  return paused;
}

export function status() {
  return {
    running: !!timer,
    paused,
    intervalSec: config.schedule.watcherIntervalSec,
    confirmTicks: config.management.confirmTicks,
    ...stats,
  };
}

/** Force one evaluation now, regardless of the interval. */
export async function tickNow() {
  paused = false;
  return sweepExits({ fast: true, actor: "watcher:manual" });
}
