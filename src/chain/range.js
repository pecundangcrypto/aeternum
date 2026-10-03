/**
 * Range geometry.
 *
 * A Whirlpool position is uniform liquidity between two tick indices. Ticks are
 * a log-scale integer grid, and only multiples of the pool's `tickSpacing` are
 * initializable, so every human-friendly "8% below price" has to be snapped
 * onto that grid before it can be opened.
 *
 * The other subtlety this module hides: a pool's price is always quoted as
 * tokenB per tokenA, but mint ordering is a byte comparison, so the volatile
 * asset lands on either side at random. Every range here is expressed in terms
 * of the BASE asset's price in the QUOTE asset, then mirrored into pool space if
 * the base happens to be tokenB.
 */

import {
  priceToTickIndex,
  tickIndexToPrice,
  getInitializableTickIndex,
  positionStatus,
  positionRatio,
  sqrtPriceToPrice,
  getFullRangeTickIndexes,
} from "@orca-so/whirlpools-core";
import { MINTS } from "../config.js";

// Preference order when both sides of a pool are quote assets (e.g. SOL/USDC).
const QUOTE_PRIORITY = [MINTS.USDC, MINTS.USDT, MINTS.SOL];

/**
 * Work out which side of the pool is the asset being farmed (base) and which is
 * the asset PnL is measured in (quote).
 *
 * @param {object} pool  an Orca API pool row (tokenMintA/tokenMintB + tokenA/tokenB)
 * @param {string[]} quoteMints  mints the agent is willing to denominate in
 */
export function resolveTokenRoles(pool, quoteMints) {
  const mintA = pool.tokenMintA;
  const mintB = pool.tokenMintB;
  const aIsQuote = quoteMints.includes(mintA);
  const bIsQuote = quoteMints.includes(mintB);

  let quoteMint;
  if (aIsQuote && bIsQuote) {
    // Both are quotes — pick by priority so SOL/USDC always reports SOL priced in USDC.
    quoteMint = QUOTE_PRIORITY.find((mint) => mint === mintA || mint === mintB) ?? mintB;
  } else if (aIsQuote) {
    quoteMint = mintA;
  } else if (bIsQuote) {
    quoteMint = mintB;
  } else {
    return { supported: false, reason: "Neither side of this pool is a configured quote asset" };
  }

  const baseMint = quoteMint === mintA ? mintB : mintA;
  const baseIsA = baseMint === mintA;
  const baseToken = baseIsA ? pool.tokenA : pool.tokenB;
  const quoteToken = baseIsA ? pool.tokenB : pool.tokenA;

  return {
    supported: true,
    baseMint,
    quoteMint,
    baseIsA,
    baseSymbol: baseToken?.symbol ?? baseMint.slice(0, 4),
    quoteSymbol: quoteToken?.symbol ?? quoteMint.slice(0, 4),
    baseDecimals: Number(baseToken?.decimals ?? 0),
    quoteDecimals: Number(quoteToken?.decimals ?? 0),
    decimalsA: Number(pool.tokenA?.decimals ?? 0),
    decimalsB: Number(pool.tokenB?.decimals ?? 0),
  };
}

/**
 * Quote candidates for valuing a position that already exists.
 *
 * `quoteMints` decides what the screener may enter, not how an open position is
 * priced. Narrowing it — to SOL only, say — would otherwise leave an existing
 * X/USDC position with no recognised quote, and valuation would fall back to
 * guessed decimals: wrong amounts, wrong PnL, and a stop loss that can fire on a
 * healthy position. The ledger remembers the quote the position was opened in;
 * without it, every known quote asset is accepted.
 */
export function valuationQuotes(entry, configured = []) {
  if (entry?.quoteMint) return [entry.quoteMint];
  return [...new Set([...configured, ...QUOTE_PRIORITY])];
}

/** Price of the base asset in quote units, derived from the pool price. */
export function basePrice(poolPrice, baseIsA) {
  if (!Number.isFinite(poolPrice) || poolPrice <= 0) return null;
  return baseIsA ? poolPrice : 1 / poolPrice;
}

/**
 * Build tick bounds for a range described as a width and a skew.
 *
 * @param {number} params.poolPrice   current tokenB-per-tokenA price
 * @param {number} params.tickSpacing pool tick spacing
 * @param {number} params.widthPct    total range width, % of price
 * @param {number} params.skew        share of the width placed below the BASE price (0..1)
 * @param {boolean} params.baseIsA    whether the base asset is tokenA
 */
export function buildRange({ poolPrice, tickSpacing, decimalsA, decimalsB, widthPct, skew, baseIsA }) {
  if (!Number.isFinite(poolPrice) || poolPrice <= 0) throw new Error("Pool price is unavailable");
  if (!Number.isFinite(widthPct) || widthPct <= 0) throw new Error("Range width must be positive");

  const width = widthPct / 100;
  // Mirror the skew when the base asset is tokenB: "below the base price" is
  // "above the pool price" in that orientation.
  const skewBelow = baseIsA ? skew : 1 - skew;

  const rawLower = poolPrice * (1 - width * skewBelow);
  const rawUpper = poolPrice * (1 + width * (1 - skewBelow));
  if (rawLower <= 0) throw new Error("Range width and skew put the lower bound at or below zero");

  const fullRange = getFullRangeTickIndexes(tickSpacing);
  const clampTick = (tick) => Math.min(fullRange.tickUpperIndex, Math.max(fullRange.tickLowerIndex, tick));

  let tickLower = clampTick(getInitializableTickIndex(priceToTickIndex(rawLower, decimalsA, decimalsB), tickSpacing, false));
  let tickUpper = clampTick(getInitializableTickIndex(priceToTickIndex(rawUpper, decimalsA, decimalsB), tickSpacing, true));

  // A one-sided range must stay entirely on its side of the price. Widening the
  // bound that touches the price would push it across by up to one tick spacing
  // and turn a "no swap needed" entry into one that needs a few percent of the
  // other asset bought — swap fee and all. Round that bound away from the price.
  const currentTick = priceToTickIndex(poolPrice, decimalsA, decimalsB);
  if (skewBelow >= 1) {
    tickUpper = clampTick(getInitializableTickIndex(currentTick, tickSpacing, false));
  } else if (skewBelow <= 0) {
    tickLower = clampTick(getInitializableTickIndex(currentTick + 1, tickSpacing, true));
  }

  // A width narrower than one tick spacing snaps to a zero-width range, which
  // the program rejects. Widen by the minimum the grid allows.
  if (tickUpper <= tickLower) {
    tickUpper = clampTick(tickLower + tickSpacing);
    if (tickUpper <= tickLower) tickLower = clampTick(tickUpper - tickSpacing);
  }
  if (tickUpper <= tickLower) throw new Error("Could not build a valid tick range for this pool");

  const priceLower = tickIndexToPrice(tickLower, decimalsA, decimalsB);
  const priceUpper = tickIndexToPrice(tickUpper, decimalsA, decimalsB);

  // Report the bounds in base-price terms, which is how a human reads them.
  const baseLower = baseIsA ? priceLower : 1 / priceUpper;
  const baseUpper = baseIsA ? priceUpper : 1 / priceLower;
  const entryBasePrice = basePrice(poolPrice, baseIsA);

  return {
    tickLower,
    tickUpper,
    tickSpacing,
    priceLower,
    priceUpper,
    baseLower,
    baseUpper,
    entryPrice: poolPrice,
    entryBasePrice,
    widthPct: Number(widthPct.toFixed(2)),
    skew: Number(skew.toFixed(3)),
    downsidePct: Number((((baseLower - entryBasePrice) / entryBasePrice) * 100).toFixed(2)),
    upsidePct: Number((((baseUpper - entryBasePrice) / entryBasePrice) * 100).toFixed(2)),
    tickCount: (tickUpper - tickLower) / tickSpacing,
  };
}

/**
 * Expected deposit split for a range, before slippage.
 *
 * Returned as fractions summing to 1, because that is what the caller multiplies
 * a capital budget by. The SDK reports basis points summing to 10000 — treating
 * those as percentages sizes every deposit 100x too large, so the conversion
 * lives here rather than at each call site.
 */
export function depositSplit({ sqrtPrice, tickLower, tickUpper }) {
  const ratio = positionRatio(BigInt(sqrtPrice), tickLower, tickUpper);
  return {
    ratioA: ratio.ratioA / 10_000,
    ratioB: ratio.ratioB / 10_000,
  };
}

export function statusFor({ sqrtPrice, tickLower, tickUpper }) {
  return positionStatus(BigInt(sqrtPrice), tickLower, tickUpper);
}

/**
 * Where the current price sits inside the range, 0 (at lower bound) to 1 (at
 * upper bound). Values outside [0,1] mean the position is out of range.
 */
export function rangePosition({ tickCurrentIndex, tickLower, tickUpper }) {
  const span = tickUpper - tickLower;
  if (span <= 0) return null;
  return Number(((tickCurrentIndex - tickLower) / span).toFixed(4));
}

/** Compact one-line range description for logs and Telegram. */
export function describeRange(range, { baseSymbol = "BASE", quoteSymbol = "QUOTE" } = {}) {
  const fmt = (value) => {
    if (!Number.isFinite(value)) return "?";
    if (value >= 1000) return value.toFixed(0);
    if (value >= 1) return value.toFixed(4);
    return value.toPrecision(4);
  };
  return `${fmt(range.baseLower)} – ${fmt(range.baseUpper)} ${quoteSymbol}/${baseSymbol} (${range.downsidePct}% / +${range.upsidePct}%, width ${range.widthPct}%)`;
}

export { sqrtPriceToPrice, tickIndexToPrice, priceToTickIndex };
