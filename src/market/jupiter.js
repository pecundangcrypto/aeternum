/**
 * Jupiter client — token research, USD pricing, and swaps.
 *
 * Orca's API describes pools; Jupiter describes the *asset* inside them (holder
 * count, market cap, holder concentration, organic-volume score, age) and is the
 * router used to fund positions and realise PnL after a close.
 *
 * Set JUPITER_API_KEY to use the paid endpoint; without it the free lite host is
 * used, which is rate limited and occasionally slow — acceptable for a bot on a
 * multi-minute cycle.
 */

import { log } from "../logger.js";
import { MINTS, config } from "../config.js";

const HAS_KEY = !!process.env.JUPITER_API_KEY;
const BASE_URL = process.env.JUPITER_API_URL || (HAS_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag");
const TIMEOUT_MS = 25_000;
const PRICE_TTL_MS = 30_000;
const TOKEN_TTL_MS = 5 * 60_000;

const tokenCache = new Map();
const priceCache = new Map();

function headers(extra = {}) {
  return {
    accept: "application/json",
    ...(HAS_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}),
    ...extra,
  };
}

async function getJson(path, query = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(name, String(value));
  }
  const response = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Jupiter ${response.status} on ${path}`);
  return response.json();
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hoursSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Number((ms / 3_600_000).toFixed(1)) : null;
}

/**
 * Full token profile. `query` may be a mint or a symbol.
 * Returns null when nothing matches — callers treat that as "unknown", not "bad".
 */
export async function tokenInfo(query) {
  const key = String(query).trim();
  if (!key) return null;

  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.value;

  try {
    const results = await getJson("/tokens/v2/search", { query: key });
    const rows = Array.isArray(results) ? results : [];
    // Prefer an exact mint match, then the most liquid result for a symbol.
    const row =
      rows.find((entry) => entry.id === key) ??
      rows.sort((left, right) => (num(right.liquidity) ?? 0) - (num(left.liquidity) ?? 0))[0];
    if (!row) return null;

    const value = {
      mint: row.id,
      symbol: row.symbol ?? null,
      name: row.name ?? null,
      decimals: num(row.decimals),
      priceUsd: num(row.usdPrice),
      mcapUsd: num(row.mcap),
      fdvUsd: num(row.fdv),
      liquidityUsd: num(row.liquidity),
      holders: num(row.holderCount),
      // 0-100, Jupiter's estimate of how much volume is organic rather than wash.
      organicScore: num(row.organicScore),
      organicLabel: row.organicScoreLabel ?? null,
      top10Pct: num(row.audit?.topHoldersPercentage),
      devBalancePct: num(row.audit?.devBalancePercentage),
      isVerified: !!row.isVerified,
      tags: Array.isArray(row.tags) ? row.tags : [],
      mintAuthority: row.mintAuthority ?? null,
      freezeAuthority: row.freezeAuthority ?? null,
      firstPoolAt: row.firstPool?.createdAt ?? null,
      ageHours: hoursSince(row.firstPool?.createdAt),
      priceChange24h: num(row.stats24h?.priceChange),
      volume24hUsd: (num(row.stats24h?.buyVolume) ?? 0) + (num(row.stats24h?.sellVolume) ?? 0) || null,
      numTraders24h: num(row.stats24h?.numTraders),
    };
    tokenCache.set(key, { at: Date.now(), value });
    if (value.mint && value.priceUsd != null) {
      priceCache.set(value.mint, { at: Date.now(), value: value.priceUsd });
    }
    return value;
  } catch (err) {
    log("jupiter_warn", `Token lookup failed for ${key.slice(0, 12)}: ${err.message}`);
    return null;
  }
}

/** USD price for one or more mints. Returns a `{ mint: price }` map. */
export async function prices(mints) {
  const wanted = [...new Set(mints.filter(Boolean))];
  const result = {};
  const missing = [];

  for (const mint of wanted) {
    const hit = priceCache.get(mint);
    if (hit && Date.now() - hit.at < PRICE_TTL_MS) result[mint] = hit.value;
    else missing.push(mint);
  }
  if (!missing.length) return result;

  try {
    const payload = await getJson("/price/v3", { ids: missing.join(",") });
    for (const mint of missing) {
      const price = num(payload?.[mint]?.usdPrice ?? payload?.data?.[mint]?.price);
      if (price == null) continue;
      result[mint] = price;
      priceCache.set(mint, { at: Date.now(), value: price });
    }
  } catch (err) {
    log("jupiter_warn", `Price lookup failed: ${err.message}`);
  }
  return result;
}

export async function priceUsd(mint) {
  const map = await prices([mint]);
  return map[mint] ?? null;
}

export async function solPriceUsd() {
  return (await priceUsd(MINTS.SOL)) ?? null;
}

// ─── Ultra swaps (with the creator fee) ─────────────────────────────────────

// Ultra's accepted range for an integrator fee. Outside it the order is rejected,
// so an out-of-range setting is dropped rather than allowed to break swaps.
const MIN_REFERRAL_BPS = 50;
const MAX_REFERRAL_BPS = 255;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The creator fee to attach, or null when it is off or misconfigured.
 *
 * Returns a reason alongside, so startup can say *why* no fee applies instead of
 * leaving the operator to guess whether their override took effect.
 */
export function creatorFeeParams() {
  const account = config.creatorFee.account;
  const bps = Math.round(Number(config.creatorFee.bps));

  if (!account) return { enabled: false, reason: "no referral account configured" };
  if (!Number.isFinite(bps) || bps <= 0) return { enabled: false, reason: "fee set to 0" };
  if (bps < MIN_REFERRAL_BPS || bps > MAX_REFERRAL_BPS) {
    return { enabled: false, reason: `${bps} bps is outside Jupiter's allowed ${MIN_REFERRAL_BPS}-${MAX_REFERRAL_BPS}` };
  }
  if (!BASE58_ADDRESS.test(account)) return { enabled: false, reason: "referral account is not a valid address" };

  return { enabled: true, account, bps, pct: bps / 100 };
}

/**
 * Request an Ultra order. With a `taker` it includes a transaction to sign;
 * without one it is a quote only, which is what dry run uses.
 *
 * If Jupiter has no initialised referral token account for the fee mint, the
 * order still succeeds and simply carries no fee — the creator fee can never be
 * the reason a user's swap fails.
 */
export async function ultraOrder({ inputMint, outputMint, amount, taker = null }) {
  const fee = creatorFeeParams();
  const payload = await getJson("/ultra/v1/order", {
    inputMint,
    outputMint,
    amount: String(BigInt(amount)),
    taker,
    ...(fee.enabled ? { referralAccount: fee.account, referralFee: fee.bps } : {}),
  });

  if (!payload?.outAmount) {
    throw new Error(payload?.errorMessage || payload?.error || "Jupiter returned no route for this pair");
  }
  if (taker && !payload.transaction) {
    throw new Error(payload.errorMessage || payload.error || "Jupiter returned no transaction for this order");
  }

  return {
    requestId: payload.requestId,
    transaction: payload.transaction || null,
    inAmount: BigInt(payload.inAmount),
    outAmount: BigInt(payload.outAmount),
    priceImpactPct: num(payload.priceImpactPct),
    // What was actually charged, as Jupiter reports it — not what was requested.
    feeBps: num(payload.platformFee?.feeBps ?? payload.feeBps),
    feeMint: payload.platformFee?.feeMint ?? payload.feeMint ?? null,
    creatorFeeRequested: fee.enabled ? fee.bps : 0,
  };
}

/** Submit a signed Ultra transaction. Jupiter lands it and reports the result. */
export async function ultraExecute({ signedTransaction, requestId }) {
  const response = await fetch(`${BASE_URL}/ultra/v1/execute`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    body: JSON.stringify({ signedTransaction, requestId }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== "Success") {
    throw new Error(payload?.error || payload?.errorMessage || `Jupiter execute failed (${response.status})`);
  }
  return {
    signature: payload.signature,
    inputAmountResult: payload.inputAmountResult ?? null,
    outputAmountResult: payload.outputAmountResult ?? null,
  };
}

export function clearCache() {
  tokenCache.clear();
  priceCache.clear();
}
