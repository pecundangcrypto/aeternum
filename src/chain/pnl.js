/**
 * Position valuation in quote-asset terms.
 *
 * PnL must be measured against one price source. Mixing them — a SOL/USD rate for
 * the entry, the pool's own price for token amounts, an oracle for the current
 * value — injects the basis between those sources straight into the result. On a
 * ZEC/USDC position the pool and the oracle disagreed by 0.17%, which showed up
 * as 0.08% of loss that never happened. Over many small exits that bias decides
 * win rate.
 *
 * So everything here is denominated in the pool's **quote asset**, using the
 * pool's own price. That number is exact, needs no oracle, and is what closing
 * the position would actually return. USD is a display conversion applied at the
 * very end and never fed back into PnL.
 */

/** Value a pair of token amounts in quote units, using the pool price. */
export function quoteValue({ amountA, amountB, poolPrice, baseIsA }) {
  if (!Number.isFinite(poolPrice) || poolPrice <= 0) return null;
  const a = Number(amountA) || 0;
  const b = Number(amountB) || 0;
  // poolPrice is tokenB per tokenA. When the base is tokenA the quote is tokenB,
  // so A converts at poolPrice. When the base is tokenB the quote is tokenA, and
  // it is B that converts — at 1/poolPrice.
  return baseIsA ? a * poolPrice + b : b / poolPrice + a;
}

/**
 * Total return on a position, in quote units and as a percentage.
 *
 * Includes uncollected fees and anything already harvested, so harvesting never
 * registers as a loss.
 */
export function computePnl({ valueQuote, feesQuote = 0, harvestedQuote = 0, entryValueQuote }) {
  const entry = Number(entryValueQuote);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(valueQuote)) {
    return { pnlQuote: null, pnlPct: null, grossQuote: null };
  }
  const gross = valueQuote + (Number(feesQuote) || 0) + (Number(harvestedQuote) || 0);
  return {
    grossQuote: round(gross, 8),
    pnlQuote: round(gross - entry, 8),
    pnlPct: round(((gross - entry) / entry) * 100, 4),
  };
}

/**
 * Net PnL in SOL — what the wallet would actually be up or down if the position
 * were closed now and everything sold back to SOL.
 *
 * Position PnL (above) answers "how is the liquidity doing". It ignores what it
 * cost to get in — funding swaps, swap fees, rent that never comes back — and
 * what it will cost to get out. On a small position those costs are of the same
 * order as the strategy's edge, so exits must be judged on this number, not the
 * gross one.
 *
 * Unlike position PnL this has to cross assets (the wallet is SOL, the position
 * is not), so it converts at USD prices. That is deliberate: it is the rate the
 * exit swaps will actually get.
 *
 * @param {object[]} params.legs  every token the close would leave in the wallet:
 *   `{ mint, amountUi, priceUsd }` — position amounts, uncollected fees and any
 *   leftovers from the entry, per mint
 * @param {number} params.solPriceUsd
 * @param {number} params.exitCostRate  fraction lost selling a non-SOL leg (fee + spread)
 * @param {number} params.rentBackSol   rent the close refunds
 * @param {number} params.solSpentSol   SOL that left the wallet to open the position
 * @param {string} params.solMint
 */
export function computeNetPnl({ legs, solPriceUsd, exitCostRate, rentBackSol = 0, solSpentSol, solMint }) {
  const spent = Number(solSpentSol);
  if (!Number.isFinite(spent) || spent <= 0 || !Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    return { netPnlSol: null, netPnlPct: null, proceedsSol: null };
  }

  let proceeds = 0;
  for (const leg of legs) {
    const amount = Number(leg.amountUi) || 0;
    if (amount <= 0) continue;
    if (leg.mint === solMint) {
      proceeds += amount;
      continue;
    }
    const price = Number(leg.priceUsd);
    // An unpriceable leg makes the whole figure unknowable — better none than wrong.
    if (!Number.isFinite(price) || price <= 0) return { netPnlSol: null, netPnlPct: null, proceedsSol: null };
    proceeds += ((amount * price) / solPriceUsd) * (1 - (Number(exitCostRate) || 0));
  }

  const rent = Number(rentBackSol) || 0;
  // Basis is the capital actually committed: refundable rent is not spent.
  const basis = spent - rent;
  const net = proceeds + rent - spent;
  return {
    proceedsSol: round(proceeds, 9),
    netPnlSol: round(net, 9),
    netPnlPct: basis > 0 ? round((net / basis) * 100, 4) : null,
  };
}

/** The PnL that counts under the configured basis, falling back to position PnL. */
export function headlinePnl(snapshot, basis) {
  const net = Number(snapshot?.netPnlPct);
  if (basis === "net" && snapshot?.netPnlPct != null && Number.isFinite(net)) {
    return { pct: net, sol: snapshot.netPnlSol ?? null, basis: "net" };
  }
  return { pct: Number(snapshot?.pnlPct), sol: snapshot?.pnlSol ?? null, basis: "position" };
}

export function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}
