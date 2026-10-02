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

export function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}
