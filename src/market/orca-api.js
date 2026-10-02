/**
 * Orca public API client.
 *
 * Pool discovery, TVL, 24h/7d fee and volume stats, token metadata and Orca's
 * own token risk score all come from here. The on-chain account is still the
 * source of truth for anything the agent acts on (price, ticks, liquidity) —
 * this API is for *finding* pools and for the USD denominators.
 *
 * Responses are cached briefly so one screening cycle doesn't refetch the same
 * pool five times while enriching candidates.
 */

import { log } from "../logger.js";

const BASE_URL = process.env.ORCA_API_URL || "https://api.orca.so/v2/solana";
const CACHE_TTL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;

const cache = new Map();

function cacheKey(path, query) {
  return `${path}?${new URLSearchParams(query).toString()}`;
}

async function fetchJson(path, query = {}, { ttlMs = CACHE_TTL_MS } = {}) {
  const key = cacheKey(path, query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const url = new URL(`${BASE_URL}${path}`);
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(name, String(value));
  }

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Orca API ${response.status} on ${path}`);
  }
  const payload = await response.json();
  cache.set(key, { at: Date.now(), value: payload });
  return payload;
}

/** Full envelope, including `meta.cursor` for pagination. */
async function requestRaw(path, query = {}, options = {}) {
  return fetchJson(path, query, options);
}

/** Just the `data` field, which is what most callers want. */
async function request(path, query = {}, options = {}) {
  const payload = await fetchJson(path, query, options);
  return payload?.data ?? payload;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalise an Orca pool row into the shape the screener works with.
 * Everything downstream reads these names, so API drift is contained here.
 */
export function normalizePool(pool) {
  const stats24h = pool?.stats?.["24h"] ?? {};
  const stats7d = pool?.stats?.["7d"] ?? {};
  const tvl = num(pool?.tvlUsdc) ?? 0;
  const fees24h = num(stats24h.fees) ?? 0;
  const volume24h = num(stats24h.volume) ?? 0;
  const rewards24h = num(stats24h.rewards) ?? 0;

  return {
    address: pool.address,
    tokenMintA: pool.tokenMintA,
    tokenMintB: pool.tokenMintB,
    tokenA: pool.tokenA,
    tokenB: pool.tokenB,
    pair: `${pool.tokenA?.symbol ?? "?"}/${pool.tokenB?.symbol ?? "?"}`,
    tickSpacing: num(pool.tickSpacing),
    // feeRate is in hundredths of a bip: 400 -> 0.04%.
    feeRatePct: num(pool.feeRate) != null ? num(pool.feeRate) / 10_000 : null,
    price: num(pool.price),
    sqrtPrice: pool.sqrtPrice,
    tickCurrentIndex: num(pool.tickCurrentIndex),
    liquidity: pool.liquidity,
    tvlUsd: tvl,
    volume24h,
    fees24h,
    rewards24h,
    // Annualised fee-only return on total pool TVL. The single most useful
    // comparable number across pools.
    feeApr: tvl > 0 ? Number(((fees24h * 365) / tvl).toFixed(4)) : null,
    totalApr: tvl > 0 ? Number((((fees24h + rewards24h) * 365) / tvl).toFixed(4)) : null,
    volumeTvlRatio: tvl > 0 ? Number((volume24h / tvl).toFixed(3)) : null,
    yieldOverTvl24h: num(stats24h.yieldOverTvl),
    priceDelta24h: num(stats24h.priceDelta),
    volumeDelta24h: num(stats24h.volumeDelta),
    tvlDelta24h: num(stats24h.tvlDelta),
    volume7d: num(stats7d.volume),
    fees7d: num(stats7d.fees),
    hasWarning: !!pool.hasWarning,
    poolType: pool.poolType ?? null,
    lockedLiquidityPct: Array.isArray(pool.lockedLiquidityPercent)
      ? Number(
          pool.lockedLiquidityPercent
            .reduce((sum, entry) => sum + (num(entry.locked_percent ?? entry.lockedPercent) ?? 0), 0)
            .toFixed(2),
        )
      : null,
    activeRewards: Array.isArray(pool.rewards) ? pool.rewards.filter((reward) => reward.active).length : 0,
    updatedAt: pool.updatedAt ?? null,
  };
}

// The API rejects anything outside this set, so requests are clamped rather
// than forwarded blindly.
const SORT_KEYS = new Set(["tvl", "volume24h", "volume"]);
const MAX_PAGE_SIZE = 50;

/**
 * List pools.
 *
 * The API pages at 50 rows via an opaque cursor, so `limit` above that walks
 * pages until it has enough. `sortBy` is clamped to the keys the API supports.
 */
export async function listPools({
  limit = 50,
  sortBy = "volume24h",
  sortDirection = "desc",
  token = null,
  tokensBothOf = null,
  minTvl = null,
} = {}) {
  const sort = SORT_KEYS.has(sortBy) ? sortBy : "volume24h";
  const pools = [];
  let cursor = null;

  while (pools.length < limit) {
    const pageSize = Math.min(MAX_PAGE_SIZE, limit - pools.length);
    const payload = await requestRaw("/pools", {
      size: pageSize,
      sortBy: sort,
      sortDirection,
      token,
      tokensBothOf: Array.isArray(tokensBothOf) ? tokensBothOf.join(",") : tokensBothOf,
      minTvl,
      after: cursor,
    });
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    pools.push(...rows.map(normalizePool));

    cursor = payload?.meta?.cursor?.next ?? null;
    if (!cursor || rows.length < pageSize) break;
  }

  return pools.slice(0, limit);
}

export async function getPool(poolAddress, { ttlMs = CACHE_TTL_MS } = {}) {
  const row = await request(`/pools/${poolAddress}`, {}, { ttlMs });
  if (!row?.address) throw new Error(`Pool ${poolAddress} not found on the Orca API`);
  return normalizePool(row);
}

/** True when the address is a Whirlpool the API knows about. */
export async function isPool(addressOrMint) {
  try {
    await getPool(addressOrMint, { ttlMs: 60_000 });
    return true;
  } catch {
    return false;
  }
}

/** Every Orca pool for a token, so the agent can pick the right tick spacing. */
export async function poolsForToken(mint, { limit = 20 } = {}) {
  return listPools({ token: mint, limit, sortBy: "volume24h" });
}

/**
 * Orca token metadata, including its 0-10 risk score.
 * Returns null rather than throwing — token data is enrichment, not a gate.
 */
export async function getToken(mint) {
  try {
    const row = await request(`/tokens/${mint}`, {}, { ttlMs: 5 * 60_000 });
    if (!row?.address) return null;
    return {
      mint: row.address,
      symbol: row.metadata?.symbol ?? null,
      name: row.metadata?.name ?? null,
      decimals: num(row.decimals),
      priceUsd: num(row.priceUsdc),
      // Orca's own 0-10 risk rating. Higher is worse.
      risk: num(row.metadata?.risk),
      tags: Array.isArray(row.tags) ? row.tags : [],
      mintAuthority: row.mintAuthority ?? null,
      freezeAuthority: row.freezeAuthority ?? null,
      volume24h: num(row.stats?.["24h"]?.volume),
    };
  } catch (err) {
    log("orca_warn", `Token lookup failed for ${mint.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Every Orca pool for a token pair, across all tick spacings.
 *
 * Same pair, different tick spacing is a genuinely different position: a
 * spacing-1 pool concentrates fees but leaves range far sooner than spacing-64.
 */
export async function poolsForPair(mintA, mintB, { limit = 20 } = {}) {
  return listPools({ tokensBothOf: [mintA, mintB], limit, sortBy: "volume24h" });
}

export function clearCache() {
  cache.clear();
}
