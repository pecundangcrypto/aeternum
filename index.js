#!/usr/bin/env node
/**
 * Aeternum — autonomous Orca Whirlpools liquidity agent.
 *
 * Entry point for the long-running process: starts the cron schedules, the fast
 * watcher, the Telegram surface, and an interactive REPL on stdin.
 *
 * Under a process manager there is no TTY, so the REPL quietly does not start and
 * the agent runs headless. Control then happens over Telegram.
 */

import readline from "node:readline";
import { config } from "./src/config.js";
import { log, logError } from "./src/logger.js";
import * as runtime from "./src/runtime.js";
import * as watcher from "./src/watcher.js";
import * as hivemind from "./src/hivemind/client.js";
import * as ledger from "./src/store/positions.js";
import * as lessons from "./src/store/lessons.js";
import { executeTool } from "./src/agent/executor.js";
import { candidatesOnly } from "./src/cycles/screen.js";

const BANNER = `
   ┌─────────────────────────────────────────────┐
   │  A E T E R N U M                            │
   │  Autonomous Orca Whirlpools liquidity agent │
   └─────────────────────────────────────────────┘
`;

function formatPct(value) {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%` : "n/a";
}

async function printStatus() {
  const status = await runtime.status();
  console.log(`
Wallet      ${status.balances.sol.toFixed(4)} SOL (${status.balances.deployableSol.toFixed(4)} deployable)
Positions   ${status.ledger.openCount}/${status.ledger.maxPositions} open${status.ledger.closedCount ? ` · ${status.ledger.closedCount} closed, ${status.ledger.winRate}% win rate` : ""}
Watcher     ${status.watcher.running ? `every ${status.watcher.intervalSec}s` : "off"}${status.watcher.paused ? " (PAUSED)" : ""} · ${status.watcher.ticks} ticks, ${status.watcher.closes} closes
Hivemind    ${status.hivemind.enabled ? `${status.hivemind.url} · ${status.hivemind.cachedLessons} shared lessons` : "off"}
Mode        ${config.dryRun ? "DRY RUN — no transactions will be signed" : "LIVE"}
`);
}

async function printPositions() {
  const result = await executeTool("get_positions");
  if (!result.positions?.length) {
    console.log("\nNo open positions.\n");
    return;
  }
  console.log("");
  for (const position of result.positions) {
    console.log(
      `${position.index}. ${position.pair ?? position.positionMint.slice(0, 8)}  ${formatPct(position.pnlPct)}  peak ${formatPct(position.peakPnlPct)}${position.trailingActive ? " [trailing armed]" : ""}`,
    );
    console.log(
      `   ${position.inRange ? "in range" : String(position.status).replace("price", "").toLowerCase()} · fees $${(position.feesUsd ?? 0).toFixed(2)} · fee APR ${position.feeApr != null ? `${(position.feeApr * 100).toFixed(0)}%` : "n/a"} · held ${position.minutesHeld}m`,
    );
    console.log(`   ${position.positionMint}`);
    if (position.note) console.log(`   note: ${position.note}`);
  }
  console.log("");
}

async function printCandidates() {
  const result = await candidatesOnly();
  if (!result.candidates.length) {
    console.log(`\nNothing passed the filters. Scanned ${result.scanned} pools, rejected ${result.rejected.length}.`);
    console.log("Most common reasons:");
    const counts = new Map();
    for (const row of result.rejected) {
      const key = row.reason.replace(/[\d.,$%]+/g, "N");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [reason, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`  ${count}×  ${reason}`);
    }
    console.log("");
    return;
  }
  console.log(`\n${result.candidates.length} candidates (${result.scanned} pools scanned)\n`);
  for (const pool of result.candidates) {
    console.log(
      `  ${String(pool.yieldScore).padStart(3)}  ${pool.pair.padEnd(18)} spacing ${String(pool.tickSpacing).padStart(3)}  fee APR ${((pool.feeApr ?? 0) * 100).toFixed(0).padStart(4)}%  turnover ${String(pool.volumeTvlRatio).padStart(6)}x  TVL $${Math.round((pool.tvlUsd ?? 0) / 1000)}k`,
    );
    console.log(`       ${pool.address}`);
  }
  console.log("");
}

const REPL_HELP = `
Commands
  /status                wallet, positions, watcher
  /positions             open positions with live PnL
  /candidates            run screening without deploying
  /screen                full screening cycle (may deploy)
  /manage                full management cycle
  /close <n>             close position n
  /config                current configuration
  /performance           closed-position statistics
  /lessons               what the agent has learned
  /evolve                retune thresholds from performance
  /pause  /resume        stop or resume the exit rules
  /hivemind              swarm sync status
  /clear                 forget the chat history
  /help                  this list
  /quit                  graceful shutdown

Anything else is a message to the agent.
`;

async function handleReplInput(line) {
  const text = line.trim();
  if (!text) return;

  const [command, ...rest] = text.split(/\s+/);
  const argument = rest.join(" ");

  switch (command.toLowerCase()) {
    case "/help":
      return console.log(REPL_HELP);
    case "/status":
      return printStatus();
    case "/positions":
      return printPositions();
    case "/candidates":
      return printCandidates();
    case "/screen": {
      const summary = await runtime.screen({ silent: true });
      return console.log(`\n${summary.skipped ? `Skipped: ${summary.reason}` : summary.report}\n`);
    }
    case "/manage": {
      const summary = await runtime.manage({ silent: true });
      return console.log(`\n${summary.closed} closed, ${summary.harvested} harvested, ${summary.held} held\n${summary.report ?? ""}\n`);
    }
    case "/close": {
      const index = Number.parseInt(argument, 10);
      const open = ledger.listOpen();
      const entry = open[index - 1];
      if (!entry) return console.log(`No position ${index}. Run /positions first.`);
      const { closeAndSettle } = await import("./src/agent/executor.js");
      const result = await closeAndSettle({
        positionMint: entry.positionMint,
        reason: "Closed manually from the REPL",
        closedBy: "repl",
      });
      return console.log(
        `\nClosed ${entry.pair ?? entry.positionMint.slice(0, 8)} at ${formatPct(result.record?.pnlPct)}\n`,
      );
    }
    case "/config":
      return console.log(`\n${JSON.stringify(await executeTool("get_config"), null, 2)}\n`);
    case "/performance":
      return console.log(`\n${JSON.stringify(lessons.performanceSummary(), null, 2)}\n`);
    case "/lessons": {
      const all = lessons.listLessons({ limit: 20 });
      if (!all.length) return console.log("\nNo lessons yet.\n");
      console.log("");
      for (const lesson of all) console.log(`${lesson.pinned ? "*" : "·"} ${lesson.rule}`);
      return console.log("");
    }
    case "/evolve": {
      const result = lessons.evolveThresholds();
      if (!result.evolved) return console.log(`\n${result.reason}\n`);
      console.log("");
      for (const change of result.changes) console.log(`${change.key}: ${change.from} → ${change.to}\n  ${change.why}`);
      return console.log("");
    }
    case "/pause":
      watcher.pause();
      return console.log("Exit rules paused.");
    case "/resume":
      watcher.resume();
      return console.log("Exit rules resumed.");
    case "/hivemind":
      return console.log(`\n${JSON.stringify(hivemind.status(), null, 2)}\n`);
    case "/clear":
      runtime.clearChatHistory();
      return console.log("Chat history cleared.");
    case "/quit":
    case "/exit":
      await shutdown(0);
      return undefined;
    default: {
      if (command.startsWith("/")) {
        return console.log(`Unknown command ${command}. /help for the list.`);
      }
      const reply = await runtime.chat(text);
      return console.log(`\n${reply}\n`);
    }
  }
}

function startRepl() {
  if (!process.stdin.isTTY) {
    log("runtime", "No TTY — running headless. Control the agent over Telegram.");
    return null;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => {
    const status = runtime.runtimeState;
    const remaining = (timestamp) => {
      if (!timestamp) return "—";
      const seconds = Math.max(0, Math.round((timestamp - Date.now()) / 1000));
      return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
    };
    rl.setPrompt(`[manage ${remaining(status.nextManageAt)} | screen ${remaining(status.nextScreenAt)}] > `);
    rl.prompt();
  };

  rl.on("line", async (line) => {
    try {
      await handleReplInput(line);
    } catch (err) {
      logError("repl", err);
    }
    prompt();
  });

  rl.on("close", () => {
    shutdown(0).catch(() => process.exit(0));
  });

  console.log(REPL_HELP);
  prompt();
  return rl;
}

let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.shutdown();
  } catch (err) {
    logError("shutdown", err);
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("unhandledRejection", (reason) => logError("unhandled", reason));

console.log(BANNER);
if (config.dryRun) {
  console.log("  DRY RUN is on — no transactions will be signed.");
  console.log("  Set DRY_RUN=false in .env to trade live.\n");
}

try {
  await runtime.start();
  startRepl();
} catch (err) {
  logError("startup", err);
  process.exit(1);
}
