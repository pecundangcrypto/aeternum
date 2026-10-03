/**
 * What it costs to get capital into a pool, and back out.
 *
 * Every position is funded from SOL. Whatever part of the deposit is not SOL has
 * to be bought on the way in and sold on the way out, and each of those swaps
 * pays Jupiter's fee plus spread. On the first live position — DOGE/USDC, both
 * legs bought from SOL — that came to roughly 1.7% per round trip, more than the
 * strategy's typical edge.
 *
 * The cost is not a property of the pool alone but of the pool *and the range*:
 *
 *   X/SOL     a range below the base price is held entirely in SOL — no swap
 *   SOL/USDC  a range above SOL's price is held entirely in SOL — no swap
 *   X/USDC    every leg is bought — the most expensive shape there is
 *
 * So this reports the cost of the configured geometry, and the geometry that
 * avoids swapping altogether, so the screener and the model can weigh both.
 */

import { config, resolveRange, MINTS } from "../config.js";
import { buildRange, depositSplit, resolveTokenRoles } from "../chain/range.js";
import { creatorFeeParams } from "./jupiter.js";

// Jupiter's own fee on a typical pair without a referral, and the spread a small
// order pays on top. Conservative round numbers, not quotes.
const BASE_SWAP_FEE_RATE = 0.001;
const SWAP_SPREAD_RATE = 0.001;

// Fixed costs per position that do not scale with size: growing a pool's shared
// tick array when a bound lands on a fresh tick (measured at 0.00156 SOL on
// mainnet; zero when the tick is already initialised), plus network fees.
const FIXED_COST_SOL = 0.0016;

/** Fraction lost on each swap between SOL and another token. */
export function swapCostRate() {
  const fee = creatorFeeParams();
  return (fee.enabled ? fee.bps / 10_000 : BASE_SWAP_FEE_RATE) + SWAP_SPREAD_RATE;
}

/**
 * Share of a deposit that is not SOL, for a given range on a given pool.
 * Returns null when the pool cannot be priced or the range cannot be built.
 */
export function nonSolShare(pool, roles, { widthPct, skew }) {
  if (!pool?.sqrtPrice || !Number.isFinite(pool.price) || !pool.tickSpacing) return null;
  try {
    const range = buildRange({
      poolPrice: pool.price,
      tickSpacing: pool.tickSpacing,
      decimalsA: roles.decimalsA,
      decimalsB: roles.decimalsB,
      widthPct,
      skew,
      baseIsA: roles.baseIsA,
    });
    const split = depositSplit({ sqrtPrice: pool.sqrtPrice, tickLower: range.tickLower, tickUpper: range.tickUpper });
    const solShare =
      (pool.tokenMintA === MINTS.SOL ? split.ratioA : 0) + (pool.tokenMintB === MINTS.SOL ? split.ratioB : 0);
    return Math.max(0, Math.min(1, 1 - solShare));
  } catch {
    return null;
  }
}

/**
 * The skew at which the whole deposit is SOL, or null if SOL is not in the pool.
 * skew is the share of the range below the BASE price, so SOL as quote wants the
 * range below (1) and SOL as base wants it above (0).
 */
export function zeroSwapSkew(roles) {
  if (roles.quoteMint === MINTS.SOL) return 1;
  if (roles.baseMint === MINTS.SOL) return 0;
  return null;
}

/**
 * Funding picture for one candidate pool.
 *
 * @param {number} params.deploySol  size of the next position, for the fixed-cost share
 */
export function estimateFunding(pool, { deploySol = null } = {}) {
  const roles = resolveTokenRoles(pool, config.screening.quoteMints);
  if (!roles.supported) return null;

  const geometry = resolveRange({ priceDelta24h: pool.priceDelta24h, volumeTvlRatio: pool.volumeTvlRatio });
  const rate = swapCostRate();
  const size = Number(deploySol) > 0 ? Number(deploySol) : null;
  const fixedPct = size ? (FIXED_COST_SOL / size) * 100 : null;

  const roundTrip = (share) => {
    if (share == null) return null;
    // In on the way in, out on the way out.
    const variable = share * rate * 2 * 100;
    return Number((variable + (fixedPct ?? 0)).toFixed(3));
  };

  const configuredShare = nonSolShare(pool, roles, geometry);
  const freeSkew = zeroSwapSkew(roles);

  return {
    solInPool: freeSkew != null,
    solSide: roles.quoteMint === MINTS.SOL ? "quote" : roles.baseMint === MINTS.SOL ? "base" : "none",
    // At the geometry the agent would use by default.
    configured: {
      widthPct: geometry.widthPct,
      skew: geometry.skew,
      nonSolSharePct: configuredShare == null ? null : Number((configuredShare * 100).toFixed(1)),
      estRoundTripCostPct: roundTrip(configuredShare),
    },
    // The one-sided geometry that needs no swap at all, if SOL is in the pool.
    zeroSwap:
      freeSkew == null
        ? null
        : {
            skew: freeSkew,
            estRoundTripCostPct: roundTrip(nonSolShare(pool, roles, { widthPct: geometry.widthPct, skew: freeSkew })),
          },
    fixedCostSol: FIXED_COST_SOL,
  };
}
