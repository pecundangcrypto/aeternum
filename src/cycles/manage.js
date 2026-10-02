/**
 * Management cycle.
 *
 * Runs in two distinct phases, and the order matters:
 *
 *   1. **Deterministic sweep.** Every position is valued and passed through the
 *      exit engine. Anything that fires is closed immediately. No model is
 *      involved — arithmetic decides, so a slow or degraded LLM can never leave a
 *      stop loss unhonoured.
 *   2. **Judgement pass.** The model reviews what survived phase 1, with the
 *      full ledger in context, and handles what rules cannot express: a position
 *      whose rationale has expired, one sitting at the edge of its range in a
 *      still-trending pair, fees worth collecting early.
 */

import { log, logError } from "../logger.js";
import { walletBalances } from "../chain/solana.js";
import * as chain from "../chain/whirlpool.js";
import { valuePosition, isPaper, inOwnBook } from "../chain/valuation.js";
import * as ledger from "../store/positions.js";
import * as journal from "../store/journal.js";
import { closeAndSettle } from "../agent/executor.js";
import { runAgent } from "../agent/loop.js";
import { reconcile } from "./reconcile.js";
import * as notify from "../notify/telegram.js";
/**
 * Value every position and apply the exit rules.
 * Shared with the fast watcher, which runs exactly this with `useAgent: false`.
 */
let sweeping = false;

export async function sweepExits({ fast = false, actor = "manager" } = {}) {
  // One sweep at a time, process-wide. The watcher and the management cron both
  // call this, and two concurrent sweeps can each see the same exit signal reach
  // its confirmation count and both submit a close.
  if (sweeping) return [];
  sweeping = true;
  try {
    return await runSweep({ fast, actor });
  } finally {
    sweeping = false;
  }
}

async function runSweep({ fast, actor }) {
  // Only this process's book: the other book belongs to a process that can
  // actually sign (or actually not sign) for it.
  const positions = ledger.listOpen().filter((entry) => inOwnBook(entry.positionMint));
  const actions = [];
  for (const entry of positions) {
    let snapshot;
    try {
      // Routes to simulated valuation for paper positions and to the chain for
      // real ones, so the exit rules below are identical in both modes.
      // The sweep is the only caller allowed to advance paper fee accrual.
      snapshot = await valuePosition(entry, { entry, fast, persist: true });
    } catch (err) {
      log("watcher_warn", `Could not value ${entry.pair ?? entry.positionMint.slice(0, 8)}: ${err.message}`);
      continue;
    }
    // Persist the parts of the snapshot the dashboard needs, so a status page can
    // render a full picture from the ledger alone without re-querying the chain.
    ledger.updatePosition(entry.positionMint, {
      last: {
        at: new Date().toISOString(),
        basePrice: snapshot.basePrice,
        status: snapshot.status,
        rangeProgress: snapshot.rangeProgress,
        valueQuote: snapshot.valueQuote,
        feesQuote: snapshot.feesQuote,
        entryValueQuote: snapshot.entryValueQuote,
        quoteSymbol: snapshot.quoteSymbol,
        valueUsd: snapshot.valueUsd,
        feesUsd: snapshot.feesUsd,
        valueSol: snapshot.valueSol,
        feesSol: snapshot.feesSol,
        pnlSol: snapshot.pnlSol,
        pnlUsd: snapshot.pnlUsd,
        pnlPct: snapshot.pnlPct,
        feeApr: snapshot.feeApr,
        amountA: snapshot.amountA,
        amountB: snapshot.amountB,
        baseSymbol: snapshot.baseSymbol,
        poolFeeApr: snapshot.poolFeeApr,
        poolTvlUsd: snapshot.poolTvlUsd,
        estimated: !!snapshot.estimated,
      },
    });

    const decision = ledger.evaluateExit(entry.positionMint, snapshot);
    if (decision.action === "close") {
      log("exit", `Closing ${entry.pair ?? entry.positionMint.slice(0, 8)}: ${decision.reason}`);
      try {
        const result = await closeAndSettle({
          positionMint: entry.positionMint,
          reason: decision.reason,
          closedBy: `${actor}:${decision.signal}`,
        });
        actions.push({ kind: "close", position: entry.positionMint, pair: entry.pair, signal: decision.signal, reason: decision.reason, record: result.record });
        await notify.positionClosed({
          pair: entry.pair ?? entry.positionMint.slice(0, 8),
          reason: decision.reason,
          record: result.record,
          trigger: decision.signal,
        });
      } catch (err) {
        logError("exit", err);
        journal.record({
          kind: "error",
          actor,
          positionMint: entry.positionMint,
          summary: "Exit rule fired but the close failed",
          reason: `${decision.reason} — close error: ${err.message}`,
        });
        await notify.alert(`Failed to close ${entry.pair ?? entry.positionMint.slice(0, 8)}: ${err.message}`);
      }
      continue;
    }
    if (decision.action === "harvest") {
      // A paper position accrues fees continuously in its own ledger; there is
      // nothing to collect, so harvesting it would be a no-op that muddies the
      // simulated fee accounting.
      if (isPaper(entry.positionMint)) {
        actions.push({ kind: "hold", position: entry.positionMint, pair: entry.pair, reason: decision.reason, snapshot });
        continue;
      }
      try {
        const result = await chain.harvestPosition({ positionMint: entry.positionMint });
        ledger.recordHarvest(entry.positionMint, { feesUsd: result.feesUsd ?? 0, tx: result.tx });
        actions.push({ kind: "harvest", position: entry.positionMint, pair: entry.pair, feesUsd: result.feesUsd });
        log("exit", `Harvested ${entry.pair ?? entry.positionMint.slice(0, 8)}: ${decision.reason}`);
      } catch (err) {
        log("exit_warn", `Harvest failed for ${entry.positionMint.slice(0, 8)}: ${err.message}`);
      }
      continue;
    }
    actions.push({ kind: "hold", position: entry.positionMint, pair: entry.pair, reason: decision.reason, pending: decision.pending ?? null, snapshot });
  }
  return actions;
}
/** Full management cycle: reconcile, sweep, then the judgement pass. */
export async function runManageCycle({ useAgent = true, silent = false } = {}) {
  const startedAt = Date.now();
  log("manage", "─── management cycle ───");
  await reconcile();
  const actions = await sweepExits({ actor: "manager" });
  const held = actions.filter((action) => action.kind === "hold");
  const closed = actions.filter((action) => action.kind === "close");
  const harvested = actions.filter((action) => action.kind === "harvest");
  let agentResult = null;
  if (useAgent && held.length) {
    const balances = await walletBalances().catch(() => null);
    const sweepNote = [
      "## This cycle's deterministic sweep",
      `Closed by rule: ${closed.length ? closed.map((action) => `${action.pair} (${action.signal})`).join(", ") : "none"}`,
      `Harvested: ${harvested.length ? harvested.map((action) => action.pair).join(", ") : "none"}`,
      "Still open after the sweep:",
      ...held.map((action) => `- ${action.pair ?? action.position.slice(0, 8)}: ${action.reason}${action.pending ? ` [${action.pending} pending confirmation]` : ""}`),
    ].join("\n");
    agentResult = await runAgent({
      role: "MANAGER",
      goal: "Review every open position. The deterministic exit rules have already run this cycle — see the sweep summary. Act only where judgement adds something the rules cannot express, and say plainly when holding is correct.",
      balances,
      extraPrompt: sweepNote,
    });
  } else if (useAgent) {
    log("manage", "No positions left after the sweep — skipping the judgement pass");
  }
  if (agentResult?.report) {
    log("manage", `report: ${agentResult.report.replace(/\s+/g, " ").slice(0, 600)}`);
  }

  const summary = {
    durationMs: Date.now() - startedAt,
    // Whether the model was consulted at all, so the caller can tell a healthy
    // "nothing to review" cycle from one where the endpoint never answered.
    agentRan: !!agentResult,
    failed: !!agentResult?.failed,
    providerError: !!agentResult?.providerError,
    closed: closed.length,
    harvested: harvested.length,
    held: held.length,
    report: agentResult?.report ?? null,
    actions,
  };
  if (!silent) await notify.manageReport(summary);
  log(
    "manage",
    `cycle done in ${(summary.durationMs / 1000).toFixed(1)}s — ${closed.length} closed, ${harvested.length} harvested, ${held.length} held`,
  );
  return summary;
}
