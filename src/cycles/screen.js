/**
 * Screening cycle.
 *
 * Checks that deploying is even possible, then hands the decision to the model.
 * The cheap pre-checks exist so a cycle with no free slot or no capital costs
 * nothing instead of a full model call — and so the reason shows up in the
 * journal rather than as unexplained silence.
 */

import { config, computeDeploySol } from "../config.js";
import { log } from "../logger.js";
import { walletBalances } from "../chain/solana.js";
import * as ledger from "../store/positions.js";
import { inOwnBook } from "../chain/valuation.js";
import * as journal from "../store/journal.js";
import { runAgent } from "../agent/loop.js";
import { screenPools } from "../market/screener.js";
import * as notify from "../notify/telegram.js";

/** Reasons not to bother running the model at all. */
async function preflight() {
  const open = ledger.listOpen().filter((entry) => inOwnBook(entry.positionMint));
  if (open.length >= config.risk.maxPositions) {
    return { blocked: `All ${config.risk.maxPositions} position slots are in use.` };
  }

  const balances = await walletBalances().catch((err) => {
    throw new Error(`Cannot read wallet balance: ${err.message}`);
  });

  if (balances.sol < config.management.minWalletSolToOpen) {
    return {
      blocked: `Wallet holds ${balances.sol.toFixed(4)} SOL, below the ${config.management.minWalletSolToOpen} SOL minimum to open a position.`,
      balances,
    };
  }
  if (balances.deployableSol < config.risk.minDeploySol) {
    return {
      blocked: `Only ${balances.deployableSol.toFixed(4)} SOL is deployable after the ${config.management.gasReserveSol} SOL gas reserve — below the ${config.risk.minDeploySol} SOL minimum position.`,
      balances,
    };
  }

  return { blocked: null, balances, slotsFree: config.risk.maxPositions - open.length };
}

export async function runScreenCycle({ silent = false } = {}) {
  const startedAt = Date.now();
  log("screen", "─── screening cycle ───");

  const check = await preflight();
  if (check.blocked) {
    log("screen", `Skipped: ${check.blocked}`);
    journal.record({ kind: "skip", actor: "screener", summary: "Screening skipped", reason: check.blocked });
    return { skipped: true, reason: check.blocked, durationMs: Date.now() - startedAt };
  }

  const sizing = computeDeploySol(check.balances.sol);
  log("screen", `${check.slotsFree} slot(s) free, ${check.balances.deployableSol.toFixed(3)} SOL deployable, next position ~${sizing} SOL`);

  const result = await runAgent({
    role: "SCREENER",
    goal: `Decide whether to open a position now. ${check.slotsFree} slot${check.slotsFree === 1 ? "" : "s"} free, roughly ${sizing} SOL available for one position. Open at most one, or record no action with your reasoning.`,
    balances: check.balances,
  });

  const opened = (result.mutations ?? []).filter((call) => call.name === "open_position");

  // The reasoning is the whole point of a headless run — without it the log says
  // "no deploy" for days and cannot be reviewed. Always record it.
  if (result.report) log("screen", `report: ${result.report.replace(/\s+/g, " ").slice(0, 600)}`);

  if (result.failed) {
    // Not a decision. The cycle never inspected anything, so filing it under
    // "no_deploy" would put an endpoint outage in the same bucket as a deliberate
    // pass — which is how nineteen hours of exhausted quota once read as normal.
    journal.record({
      kind: "error",
      actor: "screener",
      summary: result.providerError
        ? "Screening could not run — the model provider refused the request"
        : "Screening could not run — the model made no tool call",
      reason: result.report ?? "The model returned no report.",
      metrics: { model: result.model },
    });
  } else if (!opened.length) {
    const journalled = (result.calls ?? []).some((call) => call.name === "record_no_action" && !call.result?.error);
    if (!journalled) {
      // The model was asked to journal this itself and did not. Record it anyway
      // so `decisions --kind no_deploy` is never silently empty.
      journal.record({
        kind: "no_deploy",
        actor: "screener",
        summary: "No position opened this cycle",
        reason: result.report ?? "The model returned no report.",
        metrics: { toolCalls: result.steps, model: result.model },
      });
    }
  }

  const summary = {
    durationMs: Date.now() - startedAt,
    // Propagated so the runtime can tell "decided not to deploy" from "never ran"
    // and back off instead of paying for round trips that cannot work.
    failed: !!result.failed,
    providerError: !!result.providerError,
    deployed: opened.length > 0,
    opened: opened.map((call) => call.result),
    report: result.report,
    steps: result.steps,
    model: result.model,
  };

  if (!silent) await notify.screenReport(summary);
  log("screen", `cycle done in ${(summary.durationMs / 1000).toFixed(1)}s — ${summary.deployed ? "deployed" : "no deploy"}`);
  return summary;
}

/** Screening data without the model — used by the CLI and Telegram `/candidates`. */
export async function candidatesOnly({ limit = null } = {}) {
  return screenPools({ limit });
}
