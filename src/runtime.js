/**
 * Runtime orchestration.
 *
 * Owns the long-lived processes — cron schedules, the fast watcher, Telegram
 * polling, hivemind sync — and the wiring between them. Nothing here contains
 * trading logic; it decides *when* things run and what the operator surfaces can
 * reach.
 */

import cron from "node-cron";
import { config, reloadTunables, setTunable } from "./config.js";
import { log, logError } from "./logger.js";
import { walletBalances, initSdk, walletAddress, isPaperMode } from "./chain/solana.js";
import { runScreenCycle, candidatesOnly } from "./cycles/screen.js";
import { runManageCycle } from "./cycles/manage.js";
import { runAgent } from "./agent/loop.js";
import { creatorFeeParams } from "./market/jupiter.js";
import { closeAndSettle, executeTool } from "./agent/executor.js";
import * as ledger from "./store/positions.js";
import * as lessons from "./store/lessons.js";
import * as watcher from "./watcher.js";
import * as dashboard from "./dashboard.js";
import * as hivemind from "./hivemind/client.js";
import * as telegram from "./notify/telegram.js";
import * as journal from "./store/journal.js";

const state = {
  jobs: [],
  chatHistory: [],
  cycleLock: false,
  nextScreenAt: null,
  nextManageAt: null,
  startedAt: null,
};

const MAX_CHAT_HISTORY = 12;

// After this many consecutive cycles that ran but inspected nothing, stop paying
// for round trips that cannot work and say so once, loudly.
const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_RETRY_MINUTES = 30;

/**
 * Track whether the model endpoint is actually doing anything.
 *
 * A dead endpoint is indistinguishable from a quiet market if you only look at
 * "positions opened", which is how 19 hours of exhausted quota once passed for
 * normal operation.
 */
const health = { consecutiveFailures: 0, degradedSince: null, lastReason: null, nextProbeAt: null };

async function noteCycleHealth(result, kind) {
  if (!result || result.skipped) return;

  if (!result.failed) {
    if (health.degradedSince) {
      log("runtime", `Model endpoint is answering again after ${health.consecutiveFailures} failed cycle(s)`);
      await telegram.alert("Model endpoint recovered — cycles are running normally again.");
    }
    health.consecutiveFailures = 0;
    health.degradedSince = null;
    health.nextProbeAt = null;
    return;
  }

  health.consecutiveFailures += 1;
  health.lastReason = String(result.report ?? "").replace(/\s+/g, " ").slice(0, 300);

  if (health.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
    health.degradedSince = new Date().toISOString();
    const headline = result.providerError
      ? "The model provider is refusing requests"
      : "The model is returning text but never calling a tool";
    log("runtime_error", `${headline}. Pausing cycles; retrying every ${HEALTH_RETRY_MINUTES} min. Last reply: ${health.lastReason}`);
    journal.record({
      kind: "error",
      actor: "runtime",
      summary: `${kind} cycles halted — model endpoint not usable`,
      reason: health.lastReason,
    });
    await telegram.alert(`${headline}. Cycles are paused until it recovers.\n\n${health.lastReason}`);
  }

  if (health.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    health.nextProbeAt = Date.now() + HEALTH_RETRY_MINUTES * 60_000;
  }
}

/** True when the endpoint is known-bad and it is not yet time to re-probe. */
function endpointOnCooldown() {
  return !!health.degradedSince && !!health.nextProbeAt && Date.now() < health.nextProbeAt;
}

/**
 * Cycles must not overlap.
 *
 * A screening pass can run for minutes; if the management cron fires into it,
 * both read the same ledger and can act on the same position. Serialising them
 * costs a skipped tick and removes an entire class of race.
 */
async function exclusive(name, fn, { waitMs = 0 } = {}) {
  // Wait for the lock rather than dropping the cycle, when the caller can afford
  // to. Whichever cron fires first would otherwise starve the other whenever
  // their intervals share a boundary — every 30 minutes on the defaults, and
  // every single minute if the two intervals are equal.
  const deadline = Date.now() + waitMs;
  while (state.cycleLock && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (state.cycleLock) {
    log("runtime", `${name} skipped — another cycle is still running`);
    return { skipped: true, reason: "another cycle is running" };
  }

  state.cycleLock = true;
  try {
    return await fn();
  } finally {
    state.cycleLock = false;
  }
}

export async function screen(options = {}) {
  if (endpointOnCooldown()) {
    state.nextScreenAt = Date.now() + config.schedule.screenIntervalMin * 60_000;
    return { skipped: true, reason: "model endpoint unavailable — waiting before the next probe" };
  }
  const result = await exclusive("screening", () => runScreenCycle(options));
  await noteCycleHealth(result, "Screening");
  state.nextScreenAt = Date.now() + config.schedule.screenIntervalMin * 60_000;
  return result;
}

export async function manage(options = {}) {
  // Management is the safety-critical cycle, so it waits out a screening pass
  // instead of being dropped. Screening has no such claim — a missed screening
  // cycle costs an opportunity; a missed management cycle leaves a position
  // unreviewed.
  // The deterministic sweep still runs while the endpoint is down — exits must not
  // depend on the model being reachable. Only the judgement pass is skipped.
  const result = await exclusive(
    "management",
    () => runManageCycle({ ...options, useAgent: options.useAgent !== false && !endpointOnCooldown() }),
    { waitMs: 120_000 },
  );
  await noteCycleHealth(result.agentRan ? result : { ...result, failed: false }, "Management");
  state.nextManageAt = Date.now() + config.schedule.manageIntervalMin * 60_000;
  return result;
}

/** One conversational turn, with rolling history so follow-ups make sense. */
export async function chat(text) {
  const balances = await walletBalances().catch(() => null);
  const result = await runAgent({
    role: "CHAT",
    goal: text,
    history: state.chatHistory,
    balances,
  });

  state.chatHistory.push({ role: "user", content: text }, { role: "assistant", content: result.report });
  if (state.chatHistory.length > MAX_CHAT_HISTORY) {
    state.chatHistory = state.chatHistory.slice(-MAX_CHAT_HISTORY);
  }
  return result.report;
}

export function clearChatHistory() {
  state.chatHistory = [];
}

export async function status() {
  const balances = await walletBalances().catch(() => ({ sol: 0, deployableSol: 0, tokens: [] }));
  const minutesUntil = (timestamp) => (timestamp ? Math.max(0, Math.round((timestamp - Date.now()) / 60_000)) : null);

  return {
    startedAt: state.startedAt,
    dryRun: config.dryRun,
    balances,
    ledger: ledger.ledgerSummary(),
    watcher: watcher.status(),
    creatorFee: creatorFeeParams(),
    endpoint: {
      healthy: !health.degradedSince,
      consecutiveFailures: health.consecutiveFailures,
      degradedSince: health.degradedSince,
      lastReason: health.lastReason,
    },
    dashboard: dashboard.status(),
    hivemind: hivemind.status(),
    next: {
      screenMin: minutesUntil(state.nextScreenAt),
      manageMin: minutesUntil(state.nextManageAt),
    },
  };
}

/** Wire the Telegram surface to runtime behaviour. */
function wireTelegram() {
  telegram.registerActions({
    status,
    positions: () => executeTool("get_positions"),
    candidates: async () => {
      const result = await candidatesOnly();
      return { candidates: result.candidates, scanned: result.scanned, rejected: result.rejected };
    },
    performance: () => lessons.performanceSummary(),
    lessons: () => ({ lessons: lessons.listLessons({ limit: 20 }) }),
    hivemind: () => hivemind.status(),
    screen: (options) => screen({ ...options }),
    manage: (options) => manage({ ...options }),
    close: ({ positionMint, reason }) => closeAndSettle({ positionMint, reason, closedBy: "telegram" }),
    harvest: async ({ positionMint }) => {
      // Through the executor, so the book guard and the journal apply.
      const result = await executeTool("harvest_fees", { position_mint: positionMint, reason: "Harvested from Telegram" });
      if (result.error) throw new Error(result.error);
      return result;
    },
    note: ({ positionMint, note }) => ledger.setNote(positionMint, note),
    setConfig: ({ key, value, reason }) => {
      const change = setTunable(key, value);
      log("config", `${key}: ${change.previous} → ${change.value} (${reason})`);
      // Interval and model changes need their owners rebuilt to take effect.
      if (key.endsWith("IntervalMin") || key === "watcherEnabled" || key === "watcherIntervalSec") restartSchedules();
      return change;
    },
    pause: () => watcher.pause(),
    resume: () => watcher.resume(),
    evolve: () => lessons.evolveThresholds(),
    chat: ({ text }) => chat(text),
  });
}

function scheduleJobs() {
  const minutes = (value) => `*/${Math.max(1, Math.round(value))} * * * *`;

  state.jobs.push(
    // Management is registered first so that when both intervals land on the same
    // minute it takes the lock, and screening is the one that waits.
    cron.schedule(minutes(config.schedule.manageIntervalMin), () => {
      manage().catch((err) => logError("manage", err));
    }),
    cron.schedule(minutes(config.schedule.screenIntervalMin), () => {
      screen().catch((err) => logError("screen", err));
    }),
    // Re-read user-config.json periodically so edits made by hand, by the agent,
    // or by threshold evolution apply without a restart.
    cron.schedule("*/5 * * * *", () => {
      reloadTunables();
    }),
  );

  state.nextScreenAt = Date.now() + config.schedule.screenIntervalMin * 60_000;
  state.nextManageAt = Date.now() + config.schedule.manageIntervalMin * 60_000;

  log(
    "runtime",
    `Scheduled — screening every ${config.schedule.screenIntervalMin}m, management every ${config.schedule.manageIntervalMin}m`,
  );
}

function stopSchedules() {
  for (const job of state.jobs) job.stop();
  state.jobs = [];
}

function restartSchedules() {
  stopSchedules();
  watcher.stop();
  scheduleJobs();
  watcher.start();
  dashboard.start();
}

/** Boot everything. `runOnce` fires one management pass immediately. */
export async function start({ runInitialManage = true } = {}) {
  state.startedAt = new Date().toISOString();

  log("runtime", `Aeternum starting${config.dryRun ? " in DRY RUN mode" : ""}`);

  if (isPaperMode()) {
    // Not an error: paper mode is defined by the absence of a key. Saying so
    // plainly keeps days of logs readable.
    const balances = await walletBalances();
    log("runtime", `Paper mode — ${balances.sol} SOL synthetic account, no wallet key, nothing can be signed`);
  } else {
    try {
      const address = await walletAddress();
      const balances = await walletBalances();
      log("runtime", `Wallet ${address} — ${balances.sol.toFixed(4)} SOL`);
      if (!config.dryRun) await initSdk();
    } catch (err) {
      log("runtime_error", `Wallet unavailable: ${err.message}`);
      if (!config.dryRun) throw err;
    }
  }

  // Said at every start, not buried in a README: a default that takes a share of
  // the operator's swaps has to be impossible to miss.
  const fee = creatorFeeParams();
  if (fee.enabled) {
    log(
      "fees",
      `Creator fee ON: ${fee.pct.toFixed(2)}% on every Jupiter swap → ${fee.account} ` +
        `(Jupiter keeps 20% of it). Disable with AETERNUM_REFERRAL_FEE_BPS=0 in .env` +
        (isPaperMode() ? " — nothing is charged in paper mode, no real swaps happen" : ""),
    );
  } else {
    log("fees", `Creator fee off (${fee.reason})`);
  }

  await hivemind.start();

  wireTelegram();
  await telegram.startPolling();
  if (telegram.isEnabled()) {
    await telegram.send(
      `🌊 <b>Aeternum online</b>${config.dryRun ? " — <i>dry run</i>" : ""}\nScreening every ${config.schedule.screenIntervalMin}m, management every ${config.schedule.manageIntervalMin}m.\nTap a button below, or /help.`,
      { keyboard: telegram.MAIN_KEYBOARD },
    );
  }

  scheduleJobs();
  watcher.start();
  dashboard.start();

  if (runInitialManage && ledger.listOpen().length) {
    manage().catch((err) => logError("manage", err));
  }

  return { started: true };
}

export async function shutdown() {
  log("runtime", "Shutting down");
  stopSchedules();
  watcher.stop();
  dashboard.stop();
  telegram.stopPolling();
  hivemind.stop();
}

export { state as runtimeState };
