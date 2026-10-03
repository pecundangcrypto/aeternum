/**
 * Pool screening.
 *
 * Two stages, deliberately separated:
 *
 *   1. Hard filters   — deterministic rejects with a stated reason. Cheap, run
 *                       over the whole pool list, no network calls per pool.
 *   2. Enrichment      — token research (holders, mcap, concentration, age) on
 *                       the survivors only, because it costs an API call each.
 *
 * The model never sees a pool that failed a hard filter, and it never sees a
 * pool without the token data it needs to reason about risk. Rejections are
 * returned alongside the survivors so the operator can see *why* a cycle found
 * nothing — the usual reason a screener looks broken.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import * as orca from "./orca-api.js";
import * as jupiter from "./jupiter.js";
import { resolveTokenRoles } from "../chain/range.js";
import { checkBlocked } from "../store/blocklist.js";
import { checkCooldown, getPoolMemory } from "../store/pool-memory.js";
import { pendingSignals, markSignal } from "../store/signals.js";
import { estimateFunding } from "./funding.js";

/**
 * Yield Score, 0-100.
 *
 * A single comparable number across pools with wildly different sizes. Four
 * components, each saturating at a target so no one dimension can dominate:
 *
 *   fee yield  (40) — annualised fee APR, the actual reason to be an LP
 *   turnover   (25) — volume/TVL, how hard the pool's capital is working
 *   depth      (20) — TVL, because thin pools cannot absorb a real position
 *   stability  (15) — inverse 24h price move, since divergence loss eats fees
 *
 * Deliberately *not* a prediction of profit. It is a ranking device that pushes
 * the obviously-unsuitable to the bottom so the model spends its reasoning on
 * plausible candidates.
 */
export function yieldScore(pool) {
  // Log saturation, not linear. Fee APR and turnover span orders of magnitude
  // across Orca pools (40% to 1200%+), and a linear scale pins everything
  // interesting at the ceiling, which destroys the ranking exactly where it
  // matters most.
  const logSaturate = (value, ceiling) => {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(1, Math.log10(1 + value) / Math.log10(1 + ceiling));
  };

  //           input            ceiling for full marks
  const fee = logSaturate(pool.feeApr * 100, 1_200);      // 1200% annualised fee APR
  const turnover = logSaturate(pool.volumeTvlRatio, 20);  // 20x daily turnover
  const depth = logSaturate(pool.tvlUsd / 1_000, 2_000);  // $2M TVL

  const move = Math.abs(Number(pool.priceDelta24h) || 0);
  // Full marks below a 5% daily move, zero at 50% and beyond.
  const stability = Math.max(0, Math.min(1, (0.5 - move) / 0.45));

  return Math.round(fee * 40 + turnover * 25 + depth * 20 + stability * 15);
}

/**
 * Yield Score, less the cheapest achievable round-trip funding cost.
 *
 * One percentage point of round-trip cost costs ten points of score. A pool that
 * scores 85 but needs every leg bought (~1.9% on a small position) ranks below
 * one that scores 76 and can be entered without a swap. The cheapest geometry is
 * used, because the model is free to choose it.
 */
export function rankScore(candidate) {
  const f = candidate.funding;
  const costs = [f?.configured?.estRoundTripCostPct, f?.zeroSwap?.estRoundTripCostPct].filter(Number.isFinite);
  const cheapest = costs.length ? Math.min(...costs) : 0;
  return Math.round((candidate.yieldScore - cheapest * 10) * 10) / 10;
}

/** Sub-scores, for explaining a ranking rather than just asserting it. */
export function scoreBreakdown(pool) {
  return {
    total: yieldScore(pool),
    feeAprPct: pool.feeApr != null ? Number((pool.feeApr * 100).toFixed(1)) : null,
    volumeTvlRatio: pool.volumeTvlRatio,
    tvlUsd: pool.tvlUsd ? Math.round(pool.tvlUsd) : null,
    priceMove24hPct: pool.priceDelta24h != null ? Number((Math.abs(pool.priceDelta24h) * 100).toFixed(1)) : null,
  };
}

/**
 * Reject pools whose tokens carry a Token-2022 extension that is hostile to a
 * liquidity position.
 *
 * Orca lists a mint's extensions as tags, and these are not theoretical risks: a
 * transfer hook executes third-party code on every swap through the pool, and a
 * permanent delegate holds standing authority to move tokens out of accounts —
 * including, in principle, the pool vault the position's capital sits in.
 */
function extensionHazard(pool, blocked) {
  if (!blocked?.length) return null;
  for (const side of [pool.tokenA, pool.tokenB]) {
    const tags = Array.isArray(side?.tags) ? side.tags : [];
    const hit = tags.find((tag) => blocked.includes(tag));
    if (hit) return `${side.symbol ?? side.address?.slice(0, 6)} is a Token-2022 mint with the "${hit}" extension`;
  }
  return null;
}

/**
 * Deterministic rejects that need no extra network calls.
 * Returns a reason string, or null when the pool passes.
 */
function hardRejectReason(pool) {
  const s = config.screening;

  if (pool.poolType && pool.poolType !== "whirlpool") return `pool type ${pool.poolType} is not a whirlpool`;
  if (s.rejectWarningPools && pool.hasWarning) return "Orca flags this pool with a warning";

  const roles = resolveTokenRoles(pool, s.quoteMints);
  if (!roles.supported) return roles.reason;

  const blocked = checkBlocked({ pool: pool.address, mints: [pool.tokenMintA, pool.tokenMintB] });
  if (blocked.blocked) return blocked.reason;

  const cooldown = checkCooldown(pool.address);
  if (cooldown.blocked) return cooldown.reason;

  if (pool.tvlUsd < s.minTvlUsd) return `TVL $${Math.round(pool.tvlUsd)} below min $${s.minTvlUsd}`;
  if (pool.tvlUsd > s.maxTvlUsd) return `TVL $${Math.round(pool.tvlUsd)} above max $${s.maxTvlUsd}`;
  if (pool.volume24h < s.minVolume24hUsd) return `24h volume $${Math.round(pool.volume24h)} below min $${s.minVolume24hUsd}`;
  if (pool.feeApr == null || pool.feeApr < s.minFeeApr) {
    return `fee APR ${pool.feeApr != null ? `${(pool.feeApr * 100).toFixed(0)}%` : "unknown"} below min ${(s.minFeeApr * 100).toFixed(0)}%`;
  }
  if (pool.volumeTvlRatio == null || pool.volumeTvlRatio < s.minVolumeTvlRatio) {
    return `volume/TVL ${pool.volumeTvlRatio ?? "?"} below min ${s.minVolumeTvlRatio}`;
  }
  const hazard = extensionHazard(pool, s.blockedTokenExtensions);
  if (hazard) return hazard;

  if (pool.tickSpacing < s.minTickSpacing) return `tick spacing ${pool.tickSpacing} below min ${s.minTickSpacing}`;
  if (pool.tickSpacing > s.maxTickSpacing) return `tick spacing ${pool.tickSpacing} above max ${s.maxTickSpacing}`;

  const move = Math.abs(Number(pool.priceDelta24h) || 0);
  if (move > s.maxPriceDelta24h) {
    return `24h price move ${(move * 100).toFixed(0)}% above max ${(s.maxPriceDelta24h * 100).toFixed(0)}%`;
  }

  const score = yieldScore(pool);
  if (score < s.minYieldScore) return `Yield Score ${score} below min ${s.minYieldScore}`;

  return null;
}

/**
 * Token-level checks that need a Jupiter/Orca lookup.
 * Only run on pools that already passed the hard filters.
 */
async function enrichCandidate(pool, { deploySol = null } = {}) {
  const roles = resolveTokenRoles(pool, config.screening.quoteMints);
  const s = config.screening;

  const [baseToken, orcaToken] = await Promise.all([
    jupiter.tokenInfo(roles.baseMint),
    orca.getToken(roles.baseMint),
  ]);

  const reject = (reason) => ({ pool, rejected: reason });

  // Orca's own risk rating is the cheapest strong signal available.
  if (orcaToken?.risk != null && orcaToken.risk > s.maxTokenRisk) {
    return reject(`Orca token risk ${orcaToken.risk} above max ${s.maxTokenRisk}`);
  }

  if (!baseToken) {
    // No token data at all is itself a red flag for anything but a known quote asset.
    return reject("no token data available from Jupiter — unverifiable asset");
  }
  if (baseToken.mcapUsd != null && baseToken.mcapUsd < s.minMcapUsd) {
    return reject(`market cap $${Math.round(baseToken.mcapUsd)} below min $${s.minMcapUsd}`);
  }
  if (baseToken.mcapUsd != null && baseToken.mcapUsd > s.maxMcapUsd) {
    return reject(`market cap $${Math.round(baseToken.mcapUsd)} above max $${s.maxMcapUsd}`);
  }
  if (baseToken.holders != null && baseToken.holders < s.minHolders) {
    return reject(`${baseToken.holders} holders below min ${s.minHolders}`);
  }
  if (baseToken.top10Pct != null && baseToken.top10Pct > s.maxTop10Pct) {
    return reject(`top-10 holders own ${baseToken.top10Pct.toFixed(1)}% above max ${s.maxTop10Pct}%`);
  }
  if (baseToken.ageHours != null && baseToken.ageHours < s.minTokenAgeHours) {
    return reject(`token is ${baseToken.ageHours}h old, below min ${s.minTokenAgeHours}h`);
  }

  const memory = getPoolMemory(pool.address);

  return {
    pool: {
      ...pool,
      yieldScore: yieldScore(pool),
      // What getting in and out of this pool costs from a SOL wallet, at the
      // default geometry and at the one that needs no swap.
      funding: estimateFunding(pool, { deploySol }),
      scoreBreakdown: scoreBreakdown(pool),
      baseMint: roles.baseMint,
      quoteMint: roles.quoteMint,
      baseSymbol: roles.baseSymbol,
      quoteSymbol: roles.quoteSymbol,
      token: {
        symbol: baseToken.symbol,
        mcapUsd: baseToken.mcapUsd,
        holders: baseToken.holders,
        top10Pct: baseToken.top10Pct,
        organicScore: baseToken.organicScore,
        organicLabel: baseToken.organicLabel,
        ageHours: baseToken.ageHours,
        isVerified: baseToken.isVerified,
        priceChange24h: baseToken.priceChange24h,
        numTraders24h: baseToken.numTraders24h,
        orcaRisk: orcaToken?.risk ?? null,
        mintAuthority: baseToken.mintAuthority,
        freezeAuthority: baseToken.freezeAuthority,
      },
      history: memory.closes
        ? {
            deploys: memory.deploys,
            closes: memory.closes,
            wins: memory.wins,
            losses: memory.losses,
            totalPnlUsd: memory.totalPnlUsd,
            notes: memory.notes.slice(-2).map((entry) => entry.note),
          }
        : null,
    },
    rejected: null,
  };
}

/**
 * Resolve a queued signal (pool address or token mint) to candidate pools.
 * A mint resolves to its most liquid Orca pool.
 */
async function resolveSignal(signal) {
  try {
    const pool = await orca.getPool(signal.target, { ttlMs: 10_000 });
    return [{ ...pool, signalId: signal.id, signalSource: signal.source, signalNote: signal.note }];
  } catch {
    /* not a pool address — try it as a mint */
  }
  const pools = await orca.poolsForToken(signal.target, { limit: 6 }).catch(() => []);
  if (!pools.length) {
    markSignal(signal.id, "rejected", "no Orca pool found for this address");
    return [];
  }
  return pools
    .sort((left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0))
    .slice(0, 2)
    .map((pool) => ({ ...pool, signalId: signal.id, signalSource: signal.source, signalNote: signal.note }));
}

/**
 * Run a full screening pass.
 *
 * @returns {{candidates: object[], rejected: object[], signals: object[], scanned: number}}
 */
export async function screenPools({ limit = null, scanDepth = 150, deploySol = null } = {}) {
  const s = config.screening;
  const wanted = limit ?? s.candidateLimit;

  let pools = [];
  const signals = [];

  if (s.useSignals) {
    for (const signal of pendingSignals().slice(0, 5)) {
      const resolved = await resolveSignal(signal);
      if (resolved.length) {
        signals.push({ signal, pools: resolved.map((pool) => pool.address) });
        pools.push(...resolved);
      }
    }
  }

  if (s.signalMode !== "only" || !pools.length) {
    // Two passes: the busiest pools, and the deepest ones. High-yield pools show
    // up in the first, blue-chip ranges in the second; sorting by one alone
    // systematically hides the other.
    const [byVolume, byTvl] = await Promise.all([
      orca.listPools({ limit: scanDepth, sortBy: "volume24h", minTvl: s.minTvlUsd }).catch((err) => {
        log("screen_warn", `Volume scan failed: ${err.message}`);
        return [];
      }),
      orca.listPools({ limit: Math.round(scanDepth / 2), sortBy: "tvl", minTvl: s.minTvlUsd }).catch(() => []),
    ]);
    pools.push(...byVolume, ...byTvl);
  }

  const unique = new Map();
  for (const pool of pools) {
    if (!unique.has(pool.address)) unique.set(pool.address, pool);
  }
  const scanned = [...unique.values()];

  const rejected = [];
  const passed = [];
  for (const pool of scanned) {
    const reason = hardRejectReason(pool);
    if (reason) {
      rejected.push({ pool: pool.address, pair: pool.pair, reason });
      continue;
    }
    passed.push(pool);
  }

  // Enrich the strongest first and stop once we have enough, so a screening
  // cycle costs a predictable number of token lookups.
  passed.sort((left, right) => yieldScore(right) - yieldScore(left));

  const candidates = [];
  for (const pool of passed) {
    if (candidates.length >= wanted) break;
    const result = await enrichCandidate(pool, { deploySol }).catch((err) => ({ pool, rejected: `enrichment failed: ${err.message}` }));
    if (result.rejected) {
      rejected.push({ pool: pool.address, pair: pool.pair, reason: result.rejected });
      continue;
    }
    candidates.push(result.pool);
  }

  // Rank on what the pool can earn *after* what it costs to enter and leave.
  for (const candidate of candidates) candidate.rankScore = rankScore(candidate);
  candidates.sort((left, right) => right.rankScore - left.rankScore);

  log(
    "screen",
    `Scanned ${scanned.length} pools → ${passed.length} passed filters → ${candidates.length} enriched candidates (${rejected.length} rejected)`,
  );

  return { candidates, rejected, signals, scanned: scanned.length };
}

/** Full detail for one pool, as the agent's research tool returns it. */
export async function inspectPool(poolAddress) {
  const pool = await orca.getPool(poolAddress, { ttlMs: 5_000 });
  const result = await enrichCandidate(pool, { deploySol: null });
  const memory = getPoolMemory(poolAddress);
  const siblings = await orca
    .poolsForPair(pool.tokenMintA, pool.tokenMintB, { limit: 8 })
    .catch(() => []);

  return {
    pool: result.rejected ? { ...pool, yieldScore: yieldScore(pool) } : result.pool,
    wouldReject: hardRejectReason(pool) ?? result.rejected ?? null,
    memory: {
      deploys: memory.deploys,
      closes: memory.closes,
      wins: memory.wins,
      losses: memory.losses,
      totalPnlUsd: memory.totalPnlUsd,
      cooldownUntil: memory.cooldownUntil,
      notes: memory.notes,
      history: memory.history,
    },
    // Same pair at other tick spacings — often a materially better position.
    alternatives: siblings
      .filter((sibling) => sibling.address !== poolAddress)
      .map((sibling) => ({
        address: sibling.address,
        tickSpacing: sibling.tickSpacing,
        feeRatePct: sibling.feeRatePct,
        tvlUsd: sibling.tvlUsd,
        volume24h: sibling.volume24h,
        feeApr: sibling.feeApr,
        yieldScore: yieldScore(sibling),
      })),
  };
}
