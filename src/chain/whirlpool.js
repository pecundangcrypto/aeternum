/**
 * Whirlpool position operations.
 *
 * This is the only module that moves funds. Everything it does is gated on
 * `config.dryRun`, and every write path returns the same shape whether or not it
 * actually signed, so the rest of the agent behaves identically in dry-run.
 *
 * Valuation note: a Whirlpool position holds no balances of its own. Its token
 * amounts are derived from `liquidity` against the pool's current sqrt price,
 * and uncollected fees have to be reconstructed from the pool's global fee
 * growth against the position's checkpoint. Both are done exactly the way the
 * on-chain program does it, via the SDK's quote functions, so PnL matches what a
 * close would actually return.
 */

import {
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  getBase64EncodedWireTransaction,
  address,
} from "@solana/kit";
import {
  fetchWhirlpool,
  fetchPosition,
  fetchAllTickArray,
  getTickArrayAddress,
  getPositionAddress,
} from "@orca-so/whirlpools-client";
import {
  openConcentratedPositionWithTickBounds,
  closePosition as orcaClosePosition,
  harvestPosition as orcaHarvestPosition,
  decreaseLiquidity as orcaDecreaseLiquidity,
  fetchPositionsForOwner,
} from "@orca-so/whirlpools";
import {
  collectFeesQuote,
  decreaseLiquidityQuote,
  increaseLiquidityQuote,
  getTickArrayStartTickIndex,
  getTickIndexInArray,
  sqrtPriceToPrice,
  positionStatus,
} from "@orca-so/whirlpools-core";

import { config, MINTS } from "../config.js";
import { log } from "../logger.js";
import { rpc, watcherRpc, wallet, walletAddress, initSdk, LAMPORTS_PER_SOL } from "./solana.js";
import { resolveTokenRoles, valuationQuotes, buildRange, depositSplit, rangePosition, basePrice } from "./range.js";
import { quotePaperLiquidity } from "./paper.js";
import { quoteValue, computePnl, computeNetPnl } from "./pnl.js";
import * as orca from "../market/orca-api.js";
import * as jupiter from "../market/jupiter.js";

function toUi(amount, decimals) {
  return Number(amount) / 10 ** Number(decimals);
}

function toRaw(uiAmount, decimals) {
  return BigInt(Math.floor(uiAmount * 10 ** Number(decimals)));
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** On-chain pool state. Authoritative for price and ticks. */
export async function poolState(poolAddress, { client = null } = {}) {
  const account = await fetchWhirlpool(client ?? rpc(), address(poolAddress));
  return { address: poolAddress, ...account.data, account };
}

/**
 * Fetch the two tick accounts a position's bounds live in.
 * Required to reconstruct uncollected fees.
 */
async function positionTicks(client, poolAddress, tickSpacing, tickLower, tickUpper) {
  const lowerStart = getTickArrayStartTickIndex(tickLower, tickSpacing);
  const upperStart = getTickArrayStartTickIndex(tickUpper, tickSpacing);
  const [[lowerArrayAddress], [upperArrayAddress]] = await Promise.all([
    getTickArrayAddress(address(poolAddress), lowerStart),
    getTickArrayAddress(address(poolAddress), upperStart),
  ]);
  const arrays = await fetchAllTickArray(client, [lowerArrayAddress, upperArrayAddress]);
  return {
    lower: arrays[0].data.ticks[getTickIndexInArray(tickLower, lowerStart, tickSpacing)],
    upper: arrays[1].data.ticks[getTickIndexInArray(tickUpper, upperStart, tickSpacing)],
  };
}

/**
 * Live valuation of one position.
 *
 * `entry` is the ledger record (may be null for an untracked position); when
 * present it supplies the entry value that PnL is measured against.
 */
export async function positionSnapshot(positionMint, { entry = null, fast = false } = {}) {
  const client = fast ? watcherRpc() : rpc();
  const [positionAddress] = await getPositionAddress(address(positionMint));
  const position = await fetchPosition(client, positionAddress);
  const poolAddress = position.data.whirlpool;
  const pool = await fetchWhirlpool(client, poolAddress);

  const { tickLowerIndex: tickLower, tickUpperIndex: tickUpper, liquidity } = position.data;
  const { tickSpacing, sqrtPrice, tickCurrentIndex } = pool.data;

  // Pool metadata (decimals, symbols, TVL/fee stats) comes from the API; it is
  // cached and not on the hot path.
  const meta = await orca.getPool(String(poolAddress), { ttlMs: fast ? 60_000 : 20_000 }).catch(() => null);
  const roles = meta ? resolveTokenRoles(meta, valuationQuotes(entry, config.screening.quoteMints)) : { supported: false };
  const decimalsA = roles.supported ? roles.decimalsA : 9;
  const decimalsB = roles.supported ? roles.decimalsB : 9;

  const ticks = await positionTicks(client, String(poolAddress), tickSpacing, tickLower, tickUpper);
  const fees = collectFeesQuote(pool.data, position.data, ticks.lower, ticks.upper);
  const amounts = decreaseLiquidityQuote(liquidity, 0, sqrtPrice, tickLower, tickUpper);

  const amountA = toUi(amounts.tokenEstA, decimalsA);
  const amountB = toUi(amounts.tokenEstB, decimalsB);
  const feeA = toUi(fees.feeOwedA, decimalsA);
  const feeB = toUi(fees.feeOwedB, decimalsB);

  const priceMap = await jupiter.prices([String(pool.data.tokenMintA), String(pool.data.tokenMintB), config.screening.quoteMints[0]]);
  const priceA = priceMap[String(pool.data.tokenMintA)] ?? null;
  const priceB = priceMap[String(pool.data.tokenMintB)] ?? null;
  const solPrice = await jupiter.solPriceUsd();

  const valueUsd =
    priceA != null && priceB != null ? round(amountA * priceA + amountB * priceB, 4) : null;
  const feesUsd = priceA != null && priceB != null ? round(feeA * priceA + feeB * priceB, 4) : null;
  const valueSol = valueUsd != null && solPrice ? round(valueUsd / solPrice, 6) : null;
  const feesSol = feesUsd != null && solPrice ? round(feesUsd / solPrice, 6) : null;

  const poolPrice = sqrtPriceToPrice(sqrtPrice, decimalsA, decimalsB);
  const status = positionStatus(sqrtPrice, tickLower, tickUpper);

  // ── PnL, in the pool's quote asset ────────────────────────────────────────
  // One price source, no oracle basis. See src/chain/pnl.js for why this matters.
  const baseIsA = roles.supported ? roles.baseIsA : true;
  const quotePriceUsd = roles.supported ? (roles.quoteMint === String(pool.data.tokenMintA) ? priceA : priceB) : null;

  const valueQuote = quoteValue({ amountA, amountB, poolPrice, baseIsA });
  const feesQuote = quoteValue({ amountA: feeA, amountB: feeB, poolPrice, baseIsA });
  const harvestedUsd = Number(entry?.harvestedUsd ?? 0);
  const harvestedQuote = quotePriceUsd ? harvestedUsd / quotePriceUsd : 0;
  const entryValueQuote = Number(entry?.entryValueQuote);

  const { pnlQuote, pnlPct } = computePnl({
    valueQuote,
    feesQuote,
    harvestedQuote,
    entryValueQuote,
  });
  const hasEntry = Number.isFinite(entryValueQuote) && entryValueQuote > 0;

  const minutesHeld = entry?.openedAt ? Math.max(1, (Date.now() - new Date(entry.openedAt).getTime()) / 60_000) : null;

  // ── Net PnL, in SOL: what closing now and selling back would really leave ──
  const net = netPnlFor({
    entry,
    legs: [
      { mint: String(pool.data.tokenMintA), amountUi: amountA + feeA, priceUsd: priceA },
      { mint: String(pool.data.tokenMintB), amountUi: amountB + feeB, priceUsd: priceB },
    ],
    decimalsByMint: { [String(pool.data.tokenMintA)]: decimalsA, [String(pool.data.tokenMintB)]: decimalsB },
    solPrice,
  });
  // Annualised yield on deployed capital from fees alone, also in quote terms.
  const feeApr =
    hasEntry && feesQuote != null && minutesHeld
      ? round(((feesQuote + harvestedQuote) / entryValueQuote) * (525_600 / minutesHeld), 4)
      : null;

  return {
    positionMint: String(positionMint),
    positionAddress: String(positionAddress),
    pool: String(poolAddress),
    pair: meta?.pair ?? null,
    baseSymbol: roles.baseSymbol ?? null,
    quoteSymbol: roles.quoteSymbol ?? null,
    baseMint: roles.baseMint ?? null,
    quoteMint: roles.quoteMint ?? null,

    tickLower,
    tickUpper,
    tickCurrentIndex,
    tickSpacing,
    status,
    inRange: status === "priceInRange",
    rangeProgress: rangePosition({ tickCurrentIndex, tickLower, tickUpper }),

    liquidity: liquidity.toString(),
    poolPrice: round(poolPrice, 10),
    basePrice: roles.supported ? round(basePrice(poolPrice, roles.baseIsA), 10) : null,
    entryPrice: entry?.entryPrice ?? null,
    priceLower: entry?.priceLower ?? null,
    priceUpper: entry?.priceUpper ?? null,

    amountA: round(amountA, 8),
    amountB: round(amountB, 8),
    feeA: round(feeA, 8),
    feeB: round(feeB, 8),

    valueUsd,
    valueSol,
    feesUsd,
    feesSol,
    harvestedUsd: round(harvestedUsd, 4),

    // Quote-denominated basis — what PnL is actually computed from.
    quoteSymbol: roles.quoteSymbol ?? null,
    valueQuote: round(valueQuote, 8),
    feesQuote: round(feesQuote, 8),
    entryValueQuote: hasEntry ? round(entryValueQuote, 8) : null,
    pnlQuote,
    pnlPct,
    entryValueUsd: entry?.entryValueUsd ?? null,
    pnlUsd: pnlQuote != null && quotePriceUsd ? round(pnlQuote * quotePriceUsd, 4) : null,
    pnlSol: pnlQuote != null && quotePriceUsd && solPrice ? round((pnlQuote * quotePriceUsd) / solPrice, 6) : null,
    // After entry and expected exit costs. The exit rules use this when present.
    netPnlPct: net.netPnlPct,
    netPnlSol: net.netPnlSol,
    entryCostSol: net.entryCostSol,
    feeApr,
    minutesHeld: minutesHeld != null ? Math.round(minutesHeld) : null,

    poolFeeApr: meta?.feeApr ?? null,
    poolTvlUsd: meta?.tvlUsd ?? null,
    poolVolume24h: meta?.volume24h ?? null,
  };
}

/**
 * Every Whirlpool position the wallet holds, including ones opened outside the
 * agent. Position bundles are reported but not managed — they need their own
 * open/close path.
 */
export async function ownedPositions({ owner = null } = {}) {
  const target = address(owner ?? (await walletAddress()));
  const rows = await fetchPositionsForOwner(rpc(), target);
  return rows
    .filter((row) => !row.isPositionBundle)
    .map((row) => ({
      positionMint: String(row.data.positionMint),
      positionAddress: String(row.address),
      pool: String(row.data.whirlpool),
      tickLower: row.data.tickLowerIndex,
      tickUpper: row.data.tickUpperIndex,
      liquidity: row.data.liquidity.toString(),
    }));
}

// ─── Transaction plumbing ───────────────────────────────────────────────────

async function confirmSignature(signature, { timeoutMs = config.chain.confirmTimeoutMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc().getSignatureStatuses([signature]).send();
    const status = value?.[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`Transaction ${signature} not confirmed within ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Add our signature to a base64 transaction built elsewhere.
 *
 * Partial, deliberately. Ultra orders are often gasless: Jupiter is the fee payer
 * and adds its own signature in /execute, so the transaction we receive has an
 * empty signer slot. `signTransaction` insists on a fully signed result and
 * rejects every such order — which in live mode meant no funding swap and no
 * post-close swap could ever land.
 */
async function signBase64Transaction(base64) {
  const signer = await wallet();
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const signed = await partiallySignTransaction([signer.keyPair], decoded);
  return { signed, wire: getBase64EncodedWireTransaction(signed) };
}

// ─── Funding ────────────────────────────────────────────────────────────────

/**
 * Buy `targetUi` of `mint` from SOL for one leg of a new position.
 *
 * Always the full amount, never topped up from what the wallet already holds.
 * The agent may share a wallet with other activity, and tokens it did not put
 * there are not its to deposit — counting them as available capital quietly
 * spends someone else's position.
 */
async function ensureTokenBalance({ mint, targetUi, decimals, dryRun }) {
  // Native SOL needs no swap: the SDK wraps it as part of the open.
  if (mint === MINTS.SOL) return { swapped: false };

  const [solPrice, tokenPrice] = await Promise.all([jupiter.solPriceUsd(), jupiter.priceUsd(mint)]);
  if (!solPrice || !tokenPrice) throw new Error(`Cannot price ${mint.slice(0, 8)} to fund the position`);

  // Overshoot slightly: the deposit is quoted with slippage, and a shortfall
  // fails the whole open.
  const solNeeded = ((targetUi * tokenPrice) / solPrice) * 1.01;
  const lamportsIn = BigInt(Math.floor(solNeeded * LAMPORTS_PER_SOL));
  if (lamportsIn <= 0n) return { swapped: false };

  log("chain", `Funding leg: swapping ${solNeeded.toFixed(4)} SOL → ${targetUi.toFixed(6)} ${mint.slice(0, 6)}`);
  const result = await executeSwap({
    inputMint: MINTS.SOL,
    outputMint: mint,
    amountRaw: lamportsIn,
    dryRun,
  });
  return { swapped: true, ...result, decimals };
}

/**
 * Raw on-chain balance of one mint across every token account the owner holds,
 * read at "confirmed" so it reflects a transaction that just landed.
 */
async function rawTokenBalance(owner, mint) {
  const { value } = await rpc()
    .getTokenAccountsByOwner(address(owner), { mint: address(mint) }, { encoding: "jsonParsed", commitment: "confirmed" })
    .send();
  return value.reduce((sum, account) => sum + BigInt(account.account.data.parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
}

/**
 * Swap via Jupiter Ultra. Amount is raw (lamports / smallest unit) of the input mint.
 *
 * Ultra rather than the plain Swap API because it lands the transaction itself
 * and handles the creator fee safely: when no referral token account exists for
 * the fee mint, the order goes through without the fee instead of failing.
 * Slippage is managed by Ultra per route, so `slippageBps` is accepted for
 * compatibility and ignored.
 */
export async function executeSwap({ inputMint, outputMint, amountRaw, dryRun = config.dryRun }) {
  if (dryRun) {
    const quote = await jupiter.ultraOrder({ inputMint, outputMint, amount: amountRaw });
    return {
      dryRun: true,
      inAmount: quote.inAmount.toString(),
      outAmount: quote.outAmount.toString(),
      priceImpactPct: quote.priceImpactPct,
      feeBps: quote.feeBps,
      feeMint: quote.feeMint,
      tx: null,
    };
  }

  const owner = String(await walletAddress());
  const order = await jupiter.ultraOrder({ inputMint, outputMint, amount: amountRaw, taker: owner });
  const { wire } = await signBase64Transaction(order.transaction);
  const result = await jupiter.ultraExecute({ signedTransaction: wire, requestId: order.requestId });
  log(
    "chain",
    `Swap landed: ${result.signature}` + (order.feeBps ? ` (Jupiter fee ${(order.feeBps / 100).toFixed(2)}% in ${String(order.feeMint).slice(0, 4)})` : ""),
  );

  return {
    dryRun: false,
    inAmount: String(result.inputAmountResult ?? order.inAmount),
    outAmount: String(result.outputAmountResult ?? order.outAmount),
    priceImpactPct: order.priceImpactPct,
    feeBps: order.feeBps,
    feeMint: order.feeMint,
    tx: result.signature,
  };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Open a position.
 *
 * @param {string} params.pool       whirlpool address
 * @param {number} params.deploySol  capital to commit, denominated in SOL
 * @param {number} params.widthPct   range width as a % of price
 * @param {number} params.skew       share of the width below the base price
 */
export async function openPosition({ pool, deploySol, widthPct, skew, dryRun = config.dryRun }) {
  if (!dryRun) await initSdk();

  const meta = await orca.getPool(pool, { ttlMs: 5_000 });
  const roles = resolveTokenRoles(meta, config.screening.quoteMints);
  if (!roles.supported) throw new Error(roles.reason);
  if (meta.hasWarning && config.screening.rejectWarningPools) {
    throw new Error("Orca flags this pool with a warning — refusing to open");
  }

  const state = await poolState(pool);
  const poolPrice = sqrtPriceToPrice(state.sqrtPrice, roles.decimalsA, roles.decimalsB);

  const range = buildRange({
    poolPrice,
    tickSpacing: state.tickSpacing,
    decimalsA: roles.decimalsA,
    decimalsB: roles.decimalsB,
    widthPct,
    skew,
    baseIsA: roles.baseIsA,
  });

  // Split the capital the way the range demands, then make sure the wallet
  // actually holds each leg.
  const split = depositSplit({ sqrtPrice: state.sqrtPrice, tickLower: range.tickLower, tickUpper: range.tickUpper });
  const solPrice = await jupiter.solPriceUsd();
  if (!solPrice) throw new Error("Could not price SOL — refusing to size a position blind");

  const budgetUsd = deploySol * solPrice;
  const priceMap = await jupiter.prices([String(state.tokenMintA), String(state.tokenMintB)]);
  const priceA = priceMap[String(state.tokenMintA)];
  const priceB = priceMap[String(state.tokenMintB)];
  if (!priceA || !priceB) throw new Error("Could not price both sides of this pool");

  const targetA = (budgetUsd * split.ratioA) / priceA;
  const targetB = (budgetUsd * split.ratioB) / priceB;

  // Live only: the wallet's state before anything is spent, so the real cost of
  // this position can be measured rather than estimated.
  const legMints = [String(state.tokenMintA), String(state.tokenMintB)].filter((mint) => mint !== MINTS.SOL);
  const before = dryRun ? null : await walletSnapshot(legMints);

  const funding = [];
  for (const [mint, targetUi, decimals] of [
    [String(state.tokenMintA), targetA, roles.decimalsA],
    [String(state.tokenMintB), targetB, roles.decimalsB],
  ]) {
    if (targetUi <= 0) continue;
    const result = await ensureTokenBalance({ mint, targetUi, decimals, dryRun });
    if (result.swapped) funding.push({ mint, ...result });
  }

  const param = {
    tokenMaxA: toRaw(targetA, roles.decimalsA),
    tokenMaxB: toRaw(targetB, roles.decimalsB),
  };

  // What the deposit actually buys, rather than what was budgeted. The tick grid
  // and the scarcer side both cap it, and recording the budget instead shows up
  // as phantom loss on the first tick.
  const depositedLiquidity = quotePaperLiquidity({
    tokenMaxA: param.tokenMaxA,
    tokenMaxB: param.tokenMaxB,
    sqrtPrice: state.sqrtPrice,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
  });
  const deposited =
    depositedLiquidity > 0n
      ? increaseLiquidityQuote(depositedLiquidity, 0, state.sqrtPrice, range.tickLower, range.tickUpper)
      : { tokenEstA: 0n, tokenEstB: 0n };
  const depositedA = toUi(deposited.tokenEstA, roles.decimalsA);
  const depositedB = toUi(deposited.tokenEstB, roles.decimalsB);
  const entryValueQuote = quoteValue({
    amountA: depositedA,
    amountB: depositedB,
    poolPrice,
    baseIsA: roles.baseIsA,
  });
  // USD price of the quote asset, used only to present quote-denominated numbers
  // in dollars. It never enters the PnL calculation.
  const quotePriceUsd = roles.quoteMint === String(state.tokenMintA) ? priceA : priceB;
  const budgetInQuote = quotePriceUsd ? budgetUsd / quotePriceUsd : null;

  const plan = {
    pool,
    pair: meta.pair,
    baseMint: roles.baseMint,
    quoteMint: roles.quoteMint,
    baseSymbol: roles.baseSymbol,
    quoteSymbol: roles.quoteSymbol,
    deploySol: round(deploySol, 4),
    entryValueUsd: round(budgetUsd, 2),
    entryValueSol: round(deploySol, 6),
    // The authoritative basis for PnL: exact, oracle-free, in the pool's quote asset.
    entryValueQuote: round(entryValueQuote, 8),
    depositedA: round(depositedA, 8),
    depositedB: round(depositedB, 8),
    quotePriceUsd: round(quotePriceUsd, 8),
    // Budget the tick grid and the scarcer side could not absorb; stays in the wallet.
    unusedQuote: budgetInQuote != null && entryValueQuote != null ? round(budgetInQuote - entryValueQuote, 8) : null,
    entryPrice: round(poolPrice, 10),
    range,
    split: { ratioA: round(split.ratioA, 4), ratioB: round(split.ratioB, 4) },
    tokenMaxA: param.tokenMaxA.toString(),
    tokenMaxB: param.tokenMaxB.toString(),
    funding,
    entrySnapshot: {
      tvlUsd: meta.tvlUsd,
      volume24h: meta.volume24h,
      feeApr: meta.feeApr,
      volumeTvlRatio: meta.volumeTvlRatio,
      priceDelta24h: meta.priceDelta24h,
      tickSpacing: meta.tickSpacing,
      feeRatePct: meta.feeRatePct,
    },
  };

  if (dryRun) {
    // Quote the liquidity the deposit would actually have bought, so the paper
    // position can be valued against live pool state for the rest of its life.
    const paperLiquidity = quotePaperLiquidity({
      tokenMaxA: param.tokenMaxA,
      tokenMaxB: param.tokenMaxB,
      sqrtPrice: state.sqrtPrice,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
    });
    log("chain", `[dry-run] Would open ${meta.pair} ticks ${range.tickLower}..${range.tickUpper} with ${deploySol} SOL`);
    return {
      ...plan,
      dryRun: true,
      positionMint: `dryrun_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      tx: null,
      paper: { liquidity: paperLiquidity.toString(), feesUsd: 0, feesAt: new Date().toISOString() },
    };
  }

  // Building and sending can fail after the funding swaps have landed. If the
  // open never reached the chain, sell the bought legs back to SOL so capital is
  // not left stranded in tokens. Once a transaction *has* been sent, its outcome
  // is unknown on a timeout and nothing is unwound — those tokens may be inside a
  // position that landed.
  let action;
  let signature;
  try {
    action = await openConcentratedPositionWithTickBounds(
      address(pool),
      param,
      range.tickLower,
      range.tickUpper,
      { slippageToleranceBps: config.chain.slippageBps },
    );
    signature = await action.callback();
  } catch (err) {
    const unwound = await unwindFunding(funding);
    throw new Error(`Open failed before reaching the chain: ${err.message}. Funding legs ${describeUnwind(unwound)}`);
  }
  await confirmSignature(signature);

  log("chain", `Opened ${meta.pair} position ${action.positionMint} (${signature})`);
  const cost = await measureEntryCost({ before, legMints, signature }).catch((err) => {
    log("chain_warn", `Could not measure the entry cost of ${action.positionMint}: ${err.message} — net PnL unavailable`);
    return null;
  });
  return {
    ...plan,
    dryRun: false,
    positionMint: String(action.positionMint),
    initializationCostLamports: action.initializationCost?.toString?.() ?? null,
    tx: signature,
    cost,
  };
}

// Spread assumed on each exit swap, on top of the Jupiter fee Ultra reports.
const EXIT_SPREAD_RATE = 0.001;

/**
 * Net PnL for a position that has a measured entry cost; nulls otherwise
 * (paper positions, and anything opened before costs were recorded).
 */
export function netPnlFor({ entry, legs, decimalsByMint, solPrice }) {
  const cost = entry?.cost;
  if (!cost?.solSpentLamports) return { netPnlPct: null, netPnlSol: null, entryCostSol: null };

  // Leftover tokens from the entry belong to this position and go out with it.
  const withLeftovers = legs.map((leg) => ({ ...leg }));
  for (const [mint, raw] of Object.entries(cost.leftovers ?? {})) {
    const decimals = decimalsByMint[mint];
    if (decimals == null) continue;
    const leg = withLeftovers.find((item) => item.mint === mint);
    if (leg) leg.amountUi += toUi(BigInt(raw), decimals);
  }

  const fee = jupiter.creatorFeeParams();
  const exitCostRate = (fee.enabled ? fee.bps / 10_000 : 0.0002) + EXIT_SPREAD_RATE;
  const solSpentSol = Number(BigInt(cost.solSpentLamports)) / LAMPORTS_PER_SOL;
  const rentBackSol = Number(BigInt(cost.rentBackLamports ?? 0)) / LAMPORTS_PER_SOL;

  const result = computeNetPnl({
    legs: withLeftovers,
    solPriceUsd: solPrice,
    exitCostRate,
    rentBackSol,
    solSpentSol,
    solMint: MINTS.SOL,
  });
  return { netPnlPct: result.netPnlPct, netPnlSol: result.netPnlSol, entryCostSol: round(solSpentSol - rentBackSol, 9) };
}

/** SOL and leg-token balances, read at "confirmed". */
async function walletSnapshot(legMints) {
  const owner = String(await walletAddress());
  const { value: lamports } = await rpc().getBalance(address(owner), { commitment: "confirmed" }).send();
  const tokens = {};
  for (const mint of legMints) tokens[mint] = await rawTokenBalance(owner, mint);
  return { lamports: BigInt(lamports), tokens };
}

// Rent of the three accounts an Orca open creates (position, position mint and
// its token account), as measured on mainnet. Used only if the transaction
// itself cannot be read back; it is refunded when the position closes.
const FALLBACK_POSITION_RENT_LAMPORTS = 6_849_400n;

/**
 * What opening this position really cost, measured from the wallet.
 *
 *   solSpent    every lamport that left the wallet: funding swaps, swap fees,
 *               rent, tick-array growth, transaction fees
 *   rentBack    the part of that refunded on close — accounts this transaction
 *               created from nothing. Growth of a pool's shared tick array is not
 *               counted: it does not come back to us.
 *   leftovers   tokens bought for the deposit but not used by it, sold back to
 *               SOL when the position closes
 */
async function measureEntryCost({ before, legMints, signature }) {
  if (!before) return null;
  const after = await walletSnapshot(legMints);

  let rentBack = null;
  for (let attempt = 0; attempt < 5 && rentBack == null; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const tx = await rpc()
      .getTransaction(signature, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" })
      .send()
      .catch(() => null);
    if (!tx?.meta) continue;
    const pre = tx.meta.preBalances.map(BigInt);
    const post = tx.meta.postBalances.map(BigInt);
    rentBack = post.reduce((sum, value, i) => (pre[i] === 0n && value > 0n ? sum + value : sum), 0n);
  }

  const leftovers = {};
  for (const mint of legMints) {
    const extra = after.tokens[mint] - before.tokens[mint];
    if (extra > 0n) leftovers[mint] = extra.toString();
  }

  return {
    solSpentLamports: (before.lamports - after.lamports).toString(),
    rentBackLamports: (rentBack ?? FALLBACK_POSITION_RENT_LAMPORTS).toString(),
    rentMeasured: rentBack != null,
    leftovers,
  };
}

/** Sell each funding leg bought for an open that never happened back to SOL. */
async function unwindFunding(funding) {
  const results = [];
  for (const leg of funding) {
    const amountRaw = leg.outAmount != null ? BigInt(leg.outAmount) : 0n;
    if (amountRaw <= 0n) continue;
    try {
      const swap = await executeSwap({ inputMint: leg.mint, outputMint: MINTS.SOL, amountRaw, dryRun: false });
      results.push({ mint: leg.mint, ok: true, tx: swap.tx });
      log("chain", `Unwound funding leg ${leg.mint.slice(0, 6)} back to SOL (${swap.tx})`);
    } catch (err) {
      results.push({ mint: leg.mint, ok: false, error: err.message });
      log("chain_error", `Could not unwind funding leg ${leg.mint.slice(0, 6)}: ${err.message} — swap it back manually`);
    }
  }
  return results;
}

function describeUnwind(results) {
  if (!results.length) return "— none to unwind.";
  const failed = results.filter((r) => !r.ok);
  return failed.length
    ? `could not all be unwound: ${failed.map((r) => r.mint.slice(0, 6)).join(", ")} still held — swap back manually.`
    : "were sold back to SOL.";
}

/**
 * Close a position: withdraw all liquidity, collect fees and rewards, burn the
 * position NFT. Optionally sells what the position returned back to SOL so the exit is
 * actually realised rather than left as a directional bag.
 */
export async function closePosition({ positionMint, swapToSol = null, leftovers = null, dryRun = config.dryRun }) {
  const snapshot = await positionSnapshot(positionMint).catch(() => null);

  if (dryRun) {
    log("chain", `[dry-run] Would close ${positionMint}`);
    return { dryRun: true, positionMint, snapshot, tx: null, swap: null };
  }

  await initSdk();
  const owner = String(await walletAddress());

  // Every non-SOL token the position can return. Native SOL comes back
  // unwrapped and needs nothing further.
  const legs = [...new Set([snapshot?.baseMint, snapshot?.quoteMint])].filter((mint) => mint && mint !== MINTS.SOL);
  const before = Object.fromEntries(
    await Promise.all(legs.map(async (mint) => [mint, await rawTokenBalance(owner, mint).catch(() => null)])),
  );

  const action = await orcaClosePosition(address(positionMint), {
    slippageToleranceBps: config.chain.slippageBps,
  });
  const signature = await action.callback();
  await confirmSignature(signature);
  log("chain", `Closed position ${positionMint} (${signature})`);

  let swap = null;
  const shouldSwap = swapToSol ?? config.management.autoSwapToSol;
  if (shouldSwap && legs.length) {
    swap = await swapProceedsToSol({ owner, legs, before, leftovers }).catch((err) => {
      log("chain_warn", `Swapping close proceeds back to SOL failed: ${err.message}`);
      return { error: err.message };
    });
  }

  return {
    dryRun: false,
    positionMint,
    snapshot,
    quote: {
      tokenEstA: action.quote?.tokenEstA?.toString?.() ?? null,
      tokenEstB: action.quote?.tokenEstB?.toString?.() ?? null,
    },
    feesQuote: {
      feeOwedA: action.feesQuote?.feeOwedA?.toString?.() ?? null,
      feeOwedB: action.feesQuote?.feeOwedB?.toString?.() ?? null,
    },
    tx: signature,
    swap,
  };
}

/**
 * Sell exactly what the close returned — the balance increase on each non-SOL
 * leg — back to SOL.
 *
 * Only the increase. The wallet may hold the same token for unrelated reasons,
 * and selling the whole balance would liquidate it along with the exit. Retried
 * a few times, because Jupiter routes for thin tokens fail transiently and an
 * unsold leg silently turns an LP exit into a spot bet.
 */
async function swapProceedsToSol({ owner, legs, before, leftovers = null, attempts = 3 }) {
  const results = [];
  for (const mint of legs) {
    if (before[mint] == null) {
      // Without a pre-close reading the increase is unknowable; guessing could
      // sell tokens that were never the position's.
      results.push({ mint, skipped: "no pre-close balance reading — left untouched" });
      continue;
    }

    // RPC nodes can lag a just-confirmed transaction; wait for the increase.
    let delta = 0n;
    for (let read = 0; read < 5 && delta <= 0n; read += 1) {
      if (read) await new Promise((resolve) => setTimeout(resolve, 2_000));
      delta = (await rawTokenBalance(owner, mint)) - before[mint];
    }
    // Plus this position's own entry leftovers, which sat in the wallet before the
    // close — capped by what the wallet held then, so nothing else is touched.
    const leftover = BigInt(leftovers?.[mint] ?? "0");
    if (leftover > 0n) delta += leftover < before[mint] ? leftover : before[mint];
    if (delta <= 0n) {
      results.push({ mint, skipped: "close returned none of this token" });
      continue;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await executeSwap({ inputMint: mint, outputMint: MINTS.SOL, amountRaw: delta, dryRun: false });
        results.push({ mint, amountRaw: delta.toString(), ...result });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        log("chain_warn", `${mint.slice(0, 6)}→SOL swap attempt ${attempt}/${attempts} failed: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    if (lastError) results.push({ mint, amountRaw: delta.toString(), error: lastError.message });
  }
  return results;
}

/** Collect accrued fees and rewards without touching the position's liquidity. */
export async function harvestPosition({ positionMint, dryRun = config.dryRun }) {
  const snapshot = await positionSnapshot(positionMint).catch(() => null);

  if (dryRun) {
    return { dryRun: true, positionMint, feesUsd: snapshot?.feesUsd ?? null, tx: null };
  }

  await initSdk();
  const action = await orcaHarvestPosition(address(positionMint));
  const signature = await action.callback();
  await confirmSignature(signature);
  log("chain", `Harvested fees on ${positionMint} (${signature})`);

  return {
    dryRun: false,
    positionMint,
    feesUsd: snapshot?.feesUsd ?? null,
    feesQuote: {
      feeOwedA: action.feesQuote?.feeOwedA?.toString?.() ?? null,
      feeOwedB: action.feesQuote?.feeOwedB?.toString?.() ?? null,
    },
    tx: signature,
  };
}

/** Withdraw part of a position's liquidity, leaving it open. */
export async function reduceLiquidity({ positionMint, bps = 5_000, dryRun = config.dryRun }) {
  const [positionAddress] = await getPositionAddress(address(positionMint));
  const position = await fetchPosition(rpc(), positionAddress);
  const share = Math.min(10_000, Math.max(1, Math.round(bps)));
  const liquidityDelta = (position.data.liquidity * BigInt(share)) / 10_000n;
  if (liquidityDelta <= 0n) throw new Error("Nothing to withdraw — position has no liquidity");

  if (dryRun) {
    return { dryRun: true, positionMint, liquidityDelta: liquidityDelta.toString(), tx: null };
  }

  await initSdk();
  const action = await orcaDecreaseLiquidity(
    address(positionMint),
    { liquidity: liquidityDelta },
    { slippageToleranceBps: config.chain.slippageBps },
  );
  const signature = await action.callback();
  await confirmSignature(signature);
  log("chain", `Withdrew ${share / 100}% of ${positionMint} (${signature})`);

  return { dryRun: false, positionMint, liquidityDelta: liquidityDelta.toString(), tx: signature };
}
