/**
 * Paper position valuation.
 *
 * In dry run no position exists on chain, so there is nothing to read back. That
 * would make dry run useless for judging the strategy: entries get recorded and
 * then nothing ever happens to them.
 *
 * This module simulates the position instead, and does it against real state:
 *
 *   Position value — exact. The liquidity the deposit would have bought is
 *   computed with the same quote functions the program uses, then valued against
 *   the pool's live sqrt price. Divergence loss is therefore not approximated at
 *   all; it is the real thing.
 *
 *   Fee income — estimated. Fees are accrued between observations from the pool's
 *   own 24h fee flow, scaled by the share of active liquidity the position would
 *   represent, and only while the price sits inside the range. Every snapshot is
 *   marked `estimated: true` so a paper track record is never mistaken for a
 *   realised one.
 *
 * The estimate is conservative in the way that matters: it assumes fee flow
 * continues at its trailing 24h rate and ignores the pool's own liquidity
 * shifting, so it will not flatter a range that only looked good in hindsight.
 */

import {
  increaseLiquidityQuoteA,
  increaseLiquidityQuoteB,
  decreaseLiquidityQuote,
  sqrtPriceToPrice,
  positionStatus,
} from "@orca-so/whirlpools-core";

import { fetchWhirlpool } from "@orca-so/whirlpools-client";
import { address } from "@solana/kit";

import { config } from "../config.js";
import { quoteValue, computePnl } from "./pnl.js";
import { log } from "../logger.js";
import { rpc, watcherRpc } from "./solana.js";
import { rangePosition, basePrice, resolveTokenRoles, valuationQuotes } from "./range.js";
import * as orca from "../market/orca-api.js";
import * as jupiter from "../market/jupiter.js";
import { updatePosition } from "../store/positions.js";

const HOURS_PER_YEAR = 8_760;

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function toUi(amount, decimals) {
  return Number(amount) / 10 ** Number(decimals);
}

/** True for a ledger entry that exists only on paper. */
export function isPaper(positionMint) {
  return typeof positionMint === "string" && positionMint.startsWith("dryrun_");
}

/**
 * The liquidity a deposit of `tokenMaxA` / `tokenMaxB` would actually buy.
 *
 * One side constrains the other, so both are quoted and the smaller result wins
 * — the same way the program caps the deposit at whatever the range can absorb
 * from the scarcer side.
 */
export function quotePaperLiquidity({ tokenMaxA, tokenMaxB, sqrtPrice, tickLower, tickUpper }) {
  const candidates = [];

  if (tokenMaxA > 0n) {
    try {
      candidates.push(increaseLiquidityQuoteA(tokenMaxA, 0, sqrtPrice, tickLower, tickUpper).liquidityDelta);
    } catch {
      /* a range fully above price absorbs no tokenA — not an error */
    }
  }
  if (tokenMaxB > 0n) {
    try {
      candidates.push(increaseLiquidityQuoteB(tokenMaxB, 0, sqrtPrice, tickLower, tickUpper).liquidityDelta);
    } catch {
      /* likewise for a range fully below price */
    }
  }

  const usable = candidates.filter((value) => value > 0n);
  if (!usable.length) return 0n;
  return usable.reduce((smallest, value) => (value < smallest ? value : smallest));
}

/**
 * Accrue simulated fees for the interval since the last observation.
 *
 * share = ours / (pool active + ours) — the counterfactual share, since the
 * position is not actually in the pool diluting it.
 */
function accrueFees({ entry, poolFees24hUsd, poolLiquidity, paperLiquidity, inRange }) {
  const paper = entry.paper ?? {};
  const now = Date.now();
  const since = paper.feesAt ? new Date(paper.feesAt).getTime() : new Date(entry.openedAt).getTime();
  const hours = Math.max(0, (now - since) / 3_600_000);

  let feesUsd = Number(paper.feesUsd ?? 0);

  if (inRange && hours > 0 && poolFees24hUsd > 0 && paperLiquidity > 0n) {
    const ours = Number(paperLiquidity);
    const total = Number(poolLiquidity) + ours;
    const share = total > 0 ? ours / total : 0;
    feesUsd += (poolFees24hUsd / 24) * hours * share;
  }

  return { feesUsd: round(feesUsd, 6), feesAt: new Date(now).toISOString(), hours };
}

/**
 * Value a paper position against live pool state.
 *
 * Returns the same shape as a real `positionSnapshot`, so the exit engine, the
 * reports and the Telegram renderer need no special cases — the only difference
 * is the `estimated` flag.
 */
export async function paperSnapshot(entry, { fast = false, persist = false } = {}) {
  const paper = entry.paper ?? {};
  const paperLiquidity = BigInt(paper.liquidity ?? "0");

  const client = fast ? watcherRpc() : rpc();
  const [pool, meta] = await Promise.all([
    fetchWhirlpool(client, address(entry.pool)),
    orca.getPool(entry.pool, { ttlMs: fast ? 60_000 : 20_000 }).catch(() => null),
  ]);
  const state = pool.data;

  const roles = meta ? resolveTokenRoles(meta, valuationQuotes(entry, config.screening.quoteMints)) : { supported: false };
  const decimalsA = roles.supported ? roles.decimalsA : 9;
  const decimalsB = roles.supported ? roles.decimalsB : 9;

  const { sqrtPrice, tickCurrentIndex } = state;
  const { tickLower, tickUpper } = entry;

  const amounts =
    paperLiquidity > 0n
      ? decreaseLiquidityQuote(paperLiquidity, 0, sqrtPrice, tickLower, tickUpper)
      : { tokenEstA: 0n, tokenEstB: 0n };

  const amountA = toUi(amounts.tokenEstA, decimalsA);
  const amountB = toUi(amounts.tokenEstB, decimalsB);

  const status = positionStatus(sqrtPrice, tickLower, tickUpper);
  const inRange = status === "priceInRange";

  const accrued = accrueFees({
    entry,
    poolFees24hUsd: Number(meta?.fees24h ?? 0),
    poolLiquidity: state.liquidity ?? 0n,
    paperLiquidity,
    inRange,
  });

  // Only the exit sweep advances the accrual clock. A read — the CLI, the API —
  // computes the same number but must not write: the ledger is read-modify-write
  // with no cross-process lock, so a status command racing the watcher could
  // clobber `peakPnlPct` or `inRangeTicks` and silently break trailing take-profit.
  if (persist) {
    updatePosition(entry.positionMint, {
      paper: { ...paper, feesUsd: accrued.feesUsd, feesAt: accrued.feesAt },
    });
  }

  const priceMap = await jupiter.prices([String(state.tokenMintA), String(state.tokenMintB)]);
  const priceA = priceMap[String(state.tokenMintA)] ?? null;
  const priceB = priceMap[String(state.tokenMintB)] ?? null;
  const solPrice = await jupiter.solPriceUsd();

  const valueUsd = priceA != null && priceB != null ? round(amountA * priceA + amountB * priceB, 4) : null;
  const feesUsd = accrued.feesUsd;
  const valueSol = valueUsd != null && solPrice ? round(valueUsd / solPrice, 6) : null;
  const feesSol = feesUsd != null && solPrice ? round(feesUsd / solPrice, 6) : null;

  const poolPrice = sqrtPriceToPrice(sqrtPrice, decimalsA, decimalsB);

  // PnL in quote-asset terms, from the pool price alone. Fees are the estimate
  // here, not the valuation — see the module comment.
  const baseIsA = roles.supported ? roles.baseIsA : true;
  const quotePriceUsd = roles.supported ? (roles.quoteMint === String(state.tokenMintA) ? priceA : priceB) : null;

  const valueQuote = quoteValue({ amountA, amountB, poolPrice, baseIsA });
  const feesQuote = quotePriceUsd ? feesUsd / quotePriceUsd : 0;
  const harvestedUsd = Number(entry.harvestedUsd ?? 0);
  const harvestedQuote = quotePriceUsd ? harvestedUsd / quotePriceUsd : 0;
  const entryValueQuote = Number(entry.entryValueQuote);

  const { pnlQuote, pnlPct } = computePnl({ valueQuote, feesQuote, harvestedQuote, entryValueQuote });
  const hasEntry = Number.isFinite(entryValueQuote) && entryValueQuote > 0;

  const minutesHeld = Math.max(1, (Date.now() - new Date(entry.openedAt).getTime()) / 60_000);
  const feeApr = hasEntry
    ? round(((feesQuote + harvestedQuote) / entryValueQuote) * (HOURS_PER_YEAR / (minutesHeld / 60)), 4)
    : null;

  return {
    positionMint: entry.positionMint,
    positionAddress: null,
    pool: entry.pool,
    pair: entry.pair ?? meta?.pair ?? null,
    baseSymbol: entry.baseSymbol ?? roles.baseSymbol ?? null,
    quoteSymbol: entry.quoteSymbol ?? roles.quoteSymbol ?? null,
    baseMint: entry.baseMint ?? roles.baseMint ?? null,
    quoteMint: entry.quoteMint ?? roles.quoteMint ?? null,

    tickLower,
    tickUpper,
    tickCurrentIndex,
    tickSpacing: state.tickSpacing,
    status,
    inRange,
    rangeProgress: rangePosition({ tickCurrentIndex, tickLower, tickUpper }),

    liquidity: paperLiquidity.toString(),
    poolPrice: round(poolPrice, 10),
    basePrice: roles.supported ? round(basePrice(poolPrice, roles.baseIsA), 10) : null,
    entryPrice: entry.entryPrice ?? null,
    priceLower: entry.priceLower ?? null,
    priceUpper: entry.priceUpper ?? null,

    amountA: round(amountA, 8),
    amountB: round(amountB, 8),
    feeA: null,
    feeB: null,

    valueUsd,
    valueSol,
    feesUsd,
    feesSol,
    harvestedUsd: round(harvestedUsd, 4),

    quoteSymbol: roles.quoteSymbol ?? entry.quoteSymbol ?? null,
    valueQuote: round(valueQuote, 8),
    feesQuote: round(feesQuote, 8),
    entryValueQuote: hasEntry ? round(entryValueQuote, 8) : null,
    pnlQuote,
    pnlPct,
    entryValueUsd: entry.entryValueUsd ?? null,
    pnlUsd: pnlQuote != null && quotePriceUsd ? round(pnlQuote * quotePriceUsd, 4) : null,
    pnlSol: pnlQuote != null && quotePriceUsd && solPrice ? round((pnlQuote * quotePriceUsd) / solPrice, 6) : null,
    feeApr,
    minutesHeld: Math.round(minutesHeld),

    poolFeeApr: meta?.feeApr ?? null,
    poolTvlUsd: meta?.tvlUsd ?? null,
    poolVolume24h: meta?.volume24h ?? null,

    // Position value is exact; fee income is modelled. Never present a paper
    // result as a realised one.
    estimated: true,
    paper: true,
  };
}

/** Log a one-line note the first time a paper position is valued. */
export function notePaperOpen(entry) {
  log(
    "paper",
    `Paper position ${entry.pair ?? entry.positionMint} — value tracked against live pool state, fees estimated from the pool's 24h flow`,
  );
}
