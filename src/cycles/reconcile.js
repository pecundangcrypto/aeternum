/**
 * Ledger / chain reconciliation.
 *
 * The ledger and the chain drift for ordinary reasons: a position closed from the
 * Orca UI, a transaction that landed after the agent gave up waiting, a restore
 * from an old backup. Every management pass reconciles before it decides
 * anything, because acting on a position that no longer exists produces confident
 * nonsense in the report.
 */

import { log } from "../logger.js";
import * as chain from "../chain/whirlpool.js";
import { isPaperMode } from "../chain/solana.js";
import * as ledger from "../store/positions.js";
import * as journal from "../store/journal.js";

export async function reconcile() {
  // A paper run has no wallet and therefore nothing on chain to reconcile
  // against. Its positions live only in the ledger, which is authoritative.
  if (isPaperMode()) return { skipped: true, reason: "paper mode — no on-chain positions to reconcile" };

  let onChain;
  try {
    onChain = await chain.ownedPositions();
  } catch (err) {
    log("manage_warn", `Could not read on-chain positions: ${err.message}`);
    return { skipped: true, reason: err.message };
  }

  const liveMints = new Set(onChain.map((position) => position.positionMint));
  const tracked = ledger.listOpen();

  const vanished = [];
  for (const entry of tracked) {
    if (liveMints.has(entry.positionMint)) continue;
    // Dry-run positions are bookkeeping fiction and never appear on chain.
    if (entry.positionMint.startsWith("dryrun_")) continue;

    ledger.forgetPosition(entry.positionMint, "no longer held on chain");
    journal.record({
      kind: "close",
      actor: "reconcile",
      pool: entry.pool,
      pair: entry.pair,
      positionMint: entry.positionMint,
      summary: `Dropped ${entry.pair ?? entry.positionMint.slice(0, 8)} from the ledger`,
      reason: "Position is no longer held on chain — closed outside the agent, so PnL could not be recorded.",
    });
    vanished.push(entry.positionMint);
  }

  const trackedMints = new Set(ledger.listOpen().map((entry) => entry.positionMint));
  const untracked = onChain.filter((position) => !trackedMints.has(position.positionMint) && BigInt(position.liquidity) > 0n);

  if (vanished.length) log("manage", `Reconciled: dropped ${vanished.length} position(s) no longer on chain`);
  if (untracked.length) {
    log(
      "manage_warn",
      `${untracked.length} Whirlpool position(s) on chain are not tracked by this agent — exit rules do not apply to them. Adopt with: aeternum adopt --position <mint>`,
    );
  }

  return { vanished, untracked };
}

/**
 * Take over an existing on-chain position.
 *
 * Entry value is taken from its current value, so PnL is measured from adoption
 * rather than from the original entry — the honest thing to do, since the true
 * cost basis is not recoverable from chain state alone.
 */
export async function adoptPosition(positionMint, { note = null } = {}) {
  if (ledger.isTracked(positionMint)) throw new Error("Already tracked");
  if (positionMint.startsWith("dryrun_")) {
    throw new Error("That is a paper position — there is nothing on chain to adopt");
  }

  const snapshot = await chain.positionSnapshot(positionMint);
  const entry = ledger.openPosition({
    positionMint,
    pool: snapshot.pool,
    pair: snapshot.pair,
    baseMint: snapshot.baseMint,
    quoteMint: snapshot.quoteMint,
    baseSymbol: snapshot.baseSymbol,
    quoteSymbol: snapshot.quoteSymbol,
    tickLower: snapshot.tickLower,
    tickUpper: snapshot.tickUpper,
    priceLower: null,
    priceUpper: null,
    entryPrice: snapshot.basePrice,
    rangePreset: "adopted",
    widthPct: null,
    skew: null,
    deploySol: snapshot.valueSol,
    entryValueUsd: snapshot.valueUsd,
    entryValueSol: snapshot.valueSol,
    note: note ?? "Adopted — PnL is measured from adoption, not original entry",
  });

  journal.record({
    kind: "open",
    actor: "operator",
    pool: snapshot.pool,
    pair: snapshot.pair,
    positionMint,
    summary: `Adopted existing position ${snapshot.pair ?? positionMint.slice(0, 8)}`,
    reason: "Brought an externally opened position under the agent's exit rules.",
    metrics: { valueUsd: snapshot.valueUsd, status: snapshot.status },
  });

  return { adopted: true, entry, snapshot };
}
