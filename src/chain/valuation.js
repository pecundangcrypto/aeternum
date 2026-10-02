/**
 * Position valuation router.
 *
 * A paper position has no on-chain account to read, so it is valued by
 * simulation; a real one is read from the chain. Every caller that needs "what is
 * this position worth right now" goes through here, so the exit engine, the
 * reports and the Telegram renderer contain no paper/real branching at all.
 */

import { positionSnapshot } from "./whirlpool.js";
import { paperSnapshot, isPaper } from "./paper.js";
import { getPosition } from "../store/positions.js";
import { config } from "../config.js";

/**
 * Value one position.
 *
 * @param {string|object} target  a position mint, or a ledger entry
 * @param {object} [options.entry] ledger entry, when the caller already has it
 * @param {boolean} [options.fast] use the watcher RPC and longer metadata caching
 * @param {boolean} [options.persist] advance a paper position's fee accrual. Only
 *   the exit sweep may do this; reads must leave the ledger untouched.
 */
export async function valuePosition(target, { entry = null, fast = false, persist = false } = {}) {
  const positionMint = typeof target === "string" ? target : target?.positionMint;
  const ledgerEntry = entry ?? (typeof target === "object" ? target : getPosition(positionMint));

  if (isPaper(positionMint)) {
    if (!ledgerEntry) throw new Error(`Paper position ${positionMint} is not in the ledger, so it cannot be valued`);
    return paperSnapshot(ledgerEntry, { fast, persist });
  }

  return positionSnapshot(positionMint, { entry: ledgerEntry, fast });
}

/**
 * Whether this process may act on a position.
 *
 * Paper and real positions are separate books. A dry-run process acts only on
 * paper positions; a live process only on real ones. Without this, a dry-run
 * agent that hit a stop loss on a real position would "close" it in dry run —
 * sign nothing — and still drop it from the ledger, leaving real capital open
 * on chain and watched by nobody.
 */
export function inOwnBook(positionMint) {
  return isPaper(positionMint) === config.dryRun;
}

export { isPaper };
