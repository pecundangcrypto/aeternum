/**
 * Tool dispatch and safety gates.
 *
 * The model proposes; this module decides. Every risk limit is enforced here,
 * after the model has spoken and before anything is signed — an argument in the
 * prompt is a suggestion, a check in the executor is a guarantee.
 *
 * Gates re-fetch live data rather than trusting what the model was shown. A
 * screening cycle can take minutes, and a pool that qualified at the start of it
 * may not qualify by the time the model calls `open_position`.
 */

import { config, computeDeploySol, resolveRange, RANGE_PRESETS, setTunable } from "../config.js";
import { log } from "../logger.js";
import { walletBalances, isPaperMode } from "../chain/solana.js";
import * as paperAccount from "../store/paper-account.js";
import * as chain from "../chain/whirlpool.js";
import { valuePosition, isPaper, inOwnBook } from "../chain/valuation.js";
import { headlinePnl } from "../chain/pnl.js";
import * as orca from "../market/orca-api.js";
import * as jupiter from "../market/jupiter.js";
import * as screener from "../market/screener.js";
import { resolveTokenRoles } from "../chain/range.js";
import * as ledger from "../store/positions.js";
import * as journal from "../store/journal.js";
import * as lessons from "../store/lessons.js";
import * as poolMemory from "../store/pool-memory.js";
import * as blocklist from "../store/blocklist.js";
import * as hivemind from "../hivemind/client.js";
import * as notify from "../notify/telegram.js";
import { markSignal, pendingSignals } from "../store/signals.js";

class ToolRefusal extends Error {}

function refuse(message) {
  throw new ToolRefusal(message);
}

/** Base58 Solana addresses are 32-44 chars from a fixed alphabet. */
function isLikelyMint(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value ?? ""));
}

function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) refuse(`${key} is required`);
  return value.trim();
}

// ─── Gates ──────────────────────────────────────────────────────────────────

/**
 * Everything that must be true before capital moves into a new position.
 * Returns the vetted parameters; throws a refusal the model can read and react to.
 */
async function gateOpen(args) {
  const pool = requireString(args, "pool");
  // Real exposure and simulated exposure are different books with their own limits.
  const open = ledger.listOpen().filter((entry) => inOwnBook(entry.positionMint));

  if (open.length >= config.risk.maxPositions) {
    refuse(`Position limit reached: ${open.length}/${config.risk.maxPositions} open. Close one first.`);
  }
  if (open.some((entry) => entry.pool === pool)) {
    refuse("There is already an open position in this pool.");
  }

  const blocked = blocklist.checkBlocked({ pool });
  if (blocked.blocked) refuse(blocked.reason);

  const cooldown = poolMemory.checkCooldown(pool);
  if (cooldown.blocked) refuse(cooldown.reason);

  // Re-screen from live data: the candidate list the model read may be stale.
  const meta = await orca.getPool(pool, { ttlMs: 5_000 });
  const roles = resolveTokenRoles(meta, config.screening.quoteMints);
  if (!roles.supported) refuse(roles.reason);

  const mintBlocked = blocklist.checkBlocked({ mints: [meta.tokenMintA, meta.tokenMintB] });
  if (mintBlocked.blocked) refuse(mintBlocked.reason);

  if (config.risk.onePositionPerToken && open.some((entry) => entry.baseMint === roles.baseMint)) {
    refuse(`Already holding a position on ${roles.baseSymbol}. onePositionPerToken is on — two ranges on one asset is a doubled bet, not diversification.`);
  }
  if (meta.hasWarning && config.screening.rejectWarningPools) {
    refuse("Orca flags this pool with a warning.");
  }

  const score = screener.yieldScore(meta);
  if (score < config.screening.minYieldScore) {
    refuse(`Pool now scores ${score}, below the ${config.screening.minYieldScore} minimum. Conditions changed since screening.`);
  }

  // Argument validation before the balance read: an unknown preset should come
  // back as "unknown preset", not as whatever the wallet lookup happens to fail
  // with first.
  const preset = args.range_preset ? RANGE_PRESETS[args.range_preset] : null;
  if (args.range_preset && !preset) {
    refuse(`Unknown range preset "${args.range_preset}". Available: ${Object.keys(RANGE_PRESETS).join(", ")}`);
  }

  const balances = await walletBalances();
  if (balances.sol < config.management.minWalletSolToOpen) {
    refuse(`Wallet holds ${balances.sol.toFixed(4)} SOL, below the ${config.management.minWalletSolToOpen} SOL minimum to open.`);
  }

  // Size: the model may ask, but the wallet and the risk ceiling decide.
  const suggested = Number(args.deploy_sol);
  const automatic = computeDeploySol(balances.sol);
  let deploySol = Number.isFinite(suggested) && suggested > 0 ? suggested : automatic;

  if (deploySol > config.risk.maxDeploySol) {
    log("gate", `Capping deploy at maxDeploySol: ${deploySol} → ${config.risk.maxDeploySol} SOL`);
    deploySol = config.risk.maxDeploySol;
  }
  if (deploySol > balances.deployableSol) {
    log("gate", `Capping deploy at deployable balance: ${deploySol} → ${balances.deployableSol} SOL`);
    deploySol = balances.deployableSol;
  }
  if (deploySol < config.risk.minDeploySol) {
    refuse(
      `Deployable capital (${balances.deployableSol.toFixed(4)} SOL after the ${config.management.gasReserveSol} SOL gas reserve) is below the ${config.risk.minDeploySol} SOL minimum position.`,
    );
  }

  // Range geometry: preset, explicit override, or volatility-adapted default.
  const fallback = resolveRange({
    priceDelta24h: meta.priceDelta24h,
    volumeTvlRatio: meta.volumeTvlRatio,
  });

  let widthPct = Number(args.width_pct);
  if (!Number.isFinite(widthPct) || widthPct <= 0) widthPct = preset?.widthPct ?? fallback.widthPct;
  if (widthPct < config.range.minWidthPct || widthPct > config.range.maxWidthPct) {
    const clamped = Math.min(config.range.maxWidthPct, Math.max(config.range.minWidthPct, widthPct));
    log("gate", `Clamping range width ${widthPct}% → ${clamped}%`);
    widthPct = clamped;
  }

  let skew = Number(args.skew);
  if (!Number.isFinite(skew)) skew = preset?.skew ?? fallback.skew;
  skew = Math.min(1, Math.max(0, skew));

  return {
    pool,
    meta,
    roles,
    deploySol: Number(deploySol.toFixed(4)),
    widthPct: Number(widthPct.toFixed(2)),
    skew: Number(skew.toFixed(3)),
    rangePreset: args.range_preset ?? config.range.preset,
    yieldScore: score,
  };
}

/** Refuse any write on a position that belongs to the other book. */
function requireOwnBook(positionMint) {
  if (inOwnBook(positionMint)) return;
  refuse(
    isPaper(positionMint)
      ? "That is a paper position and this process is live."
      : "That is a real on-chain position and this process is in dry run — it can only be changed from a live process (--live).",
  );
}

function gateClose(positionMint) {
  const entry = ledger.getPosition(positionMint);
  if (!entry) {
    // Not in the ledger is not automatically a refusal — the operator may be
    // closing a position opened by hand. The chain call will fail if it is not
    // really ours.
    log("gate_warn", `Closing untracked position ${positionMint}`);
  }
  return entry;
}

// ─── Close pipeline ─────────────────────────────────────────────────────────

/**
 * Close a position and run every follow-on step: ledger, pool memory, derived
 * lesson, swarm share, journal.
 *
 * Shared by the manager cycle, the watcher, Telegram, and the CLI, so an exit
 * always has identical bookkeeping regardless of what triggered it.
 */
export async function closeAndSettle({ positionMint, reason, closedBy = "agent", skipSwap = false }) {
  if (!inOwnBook(positionMint)) {
    throw new ToolRefusal(
      isPaper(positionMint)
        ? "That is a paper position and this process is live — it can only be closed by a dry-run process."
        : "That is a real on-chain position and this process is in dry run — closing it here would sign nothing but still drop it from the ledger. Close it from a live process (--live).",
    );
  }
  const entry = gateClose(positionMint);
  const before = await valuePosition(positionMint, { entry }).catch(() => null);

  let result;
  if (isPaper(positionMint)) {
    // Nothing to sign. The proceeds go back to the paper account so the running
    // balance reflects the strategy's actual result over the run.
    const proceedsSol = (before?.valueSol ?? 0) + (before?.feesSol ?? 0);
    paperAccount.credit(proceedsSol, { label: `close ${entry?.pair ?? positionMint.slice(0, 12)}` });
    result = { dryRun: true, paper: true, positionMint, tx: null, swap: null, proceedsSol };
  } else {
    result = await chain.closePosition({
      positionMint,
      swapToSol: skipSwap ? false : null,
      // Tokens bought for this position's entry but not deposited go out with it.
      leftovers: entry?.cost?.leftovers ?? null,
    });
  }

  const record = entry
    ? ledger.recordClose(positionMint, {
        reason,
        closedBy,
        tx: result.tx,
        exitPrice: before?.poolPrice ?? null,
        exitValueUsd: before?.valueUsd ?? null,
        exitValueSol: before?.valueSol ?? null,
        feesUsd: before?.feesUsd ?? 0,
        feesSol: before?.feesSol ?? 0,
        pnlUsd: before?.pnlUsd ?? null,
        // Net when the entry cost was measured: performance stats, lessons and
        // threshold evolution all learn from this field, and they should learn
        // from what reached the wallet.
        pnlSol: headlinePnl(before, config.management.pnlBasis).sol,
        pnlPct: before ? headlinePnl(before, config.management.pnlBasis).pct : null,
        grossPnlPct: before?.pnlPct ?? null,
        netPnlPct: before?.netPnlPct ?? null,
        pnlBasis: headlinePnl(before, config.management.pnlBasis).basis,
        rangeEfficiency: ledger.rangeEfficiency(entry),
        exitSnapshot: before
          ? { status: before.status, poolFeeApr: before.poolFeeApr, poolTvlUsd: before.poolTvlUsd }
          : null,
      })
    : null;

  if (record) {
    poolMemory.recordClose(record.pool, record);
    const lesson = lessons.deriveLessonFromClose(record);
    if (lesson) hivemind.pushLesson(lesson).catch(() => null);
    hivemind.pushOutcome(record).catch(() => null);
  }

  journal.record({
    kind: "close",
    actor: closedBy,
    pool: entry?.pool ?? before?.pool,
    pair: entry?.pair ?? before?.pair,
    positionMint,
    summary: record
      ? `Closed ${record.pair ?? positionMint.slice(0, 8)} at ${record.pnlPct != null ? `${record.pnlPct > 0 ? "+" : ""}${record.pnlPct.toFixed(2)}%` : "unknown PnL"} after ${record.minutesHeld}m`
      : `Closed ${positionMint.slice(0, 8)}`,
    reason,
    metrics: record
      ? {
          pnlPct: record.pnlPct,
          pnlUsd: record.pnlUsd,
          feesUsd: record.feesUsd,
          minutesHeld: record.minutesHeld,
          peakPnlPct: record.peakPnlPct,
          rangeEfficiency: record.rangeEfficiency,
        }
      : null,
  });

  return { ...result, record, snapshot: before };
}

/** Open a position and run every follow-on step. Shared by the cycle and the CLI. */
export async function openAndTrack(vetted, { reason, risks = [], rejected = [], actor = "screener", note = null }) {
  const result = await chain.openPosition({
    pool: vetted.pool,
    deploySol: vetted.deploySol,
    widthPct: vetted.widthPct,
    skew: vetted.skew,
  });

  if (result.paper) {
    paperAccount.debit(result.deploySol, { label: `open ${result.pair}` });
  }

  const entry = ledger.openPosition({
    positionMint: result.positionMint,
    paper: result.paper ?? null,
    pool: vetted.pool,
    pair: result.pair,
    baseMint: result.baseMint,
    quoteMint: result.quoteMint,
    baseSymbol: result.baseSymbol,
    quoteSymbol: result.quoteSymbol,
    tickLower: result.range.tickLower,
    tickUpper: result.range.tickUpper,
    priceLower: result.range.baseLower,
    priceUpper: result.range.baseUpper,
    entryPrice: result.range.entryBasePrice,
    rangePreset: vetted.rangePreset,
    widthPct: result.range.widthPct,
    skew: result.range.skew,
    deploySol: result.deploySol,
    entryValueUsd: result.entryValueUsd,
    entryValueSol: result.entryValueSol,
    entryValueQuote: result.entryValueQuote,
    cost: result.cost ?? null,
    entrySnapshot: result.entrySnapshot,
    openTx: result.tx,
    note,
  });

  poolMemory.recordDeploy(vetted.pool, {
    pair: result.pair,
    rangePreset: vetted.rangePreset,
    widthPct: result.range.widthPct,
    entryValueUsd: result.entryValueUsd,
  });

  journal.record({
    kind: "open",
    actor,
    pool: vetted.pool,
    pair: result.pair,
    positionMint: result.positionMint,
    summary: `Opened ${result.pair} with ${result.deploySol} SOL, range ${result.range.downsidePct}%/+${result.range.upsidePct}% (width ${result.range.widthPct}%, skew ${result.range.skew})`,
    reason,
    risks,
    rejected,
    metrics: {
      yieldScore: vetted.yieldScore,
      feeApr: vetted.meta.feeApr,
      volumeTvlRatio: vetted.meta.volumeTvlRatio,
      tvlUsd: vetted.meta.tvlUsd,
      priceDelta24h: vetted.meta.priceDelta24h,
      tickSpacing: vetted.meta.tickSpacing,
      entryValueUsd: result.entryValueUsd,
    },
  });

  await notify.positionOpened({
    pair: result.pair,
    dryRun: result.dryRun,
    deploySol: result.deploySol,
    entryValueUsd: result.entryValueUsd,
    range: result.range,
    depositSplit: result.split,
    tx: result.tx,
  });

  return { result, entry };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

const HANDLERS = {
  async get_wallet_balance() {
    const balances = await walletBalances();
    const solPrice = await jupiter.solPriceUsd();
    return {
      ...balances,
      ...(isPaperMode() ? { paperAccount: paperAccount.summary() } : {}),
      solPriceUsd: solPrice,
      valueUsd: solPrice ? Number((balances.sol * solPrice).toFixed(2)) : null,
      gasReserveSol: config.management.gasReserveSol,
      nextPositionSizeSol: computeDeploySol(balances.sol),
    };
  },

  async get_positions() {
    const open = ledger.listOpen();
    if (!open.length) return { count: 0, positions: [], note: "No open positions." };

    const positions = [];
    for (const entry of open) {
      const snapshot = await valuePosition(entry, { entry }).catch((err) => ({ error: err.message }));
      positions.push({
        ...snapshot,
        index: positions.length + 1,
        note: entry.note,
        peakPnlPct: entry.peakPnlPct,
        trailingActive: entry.trailingActive,
        outOfRangeSince: entry.outOfRangeSince,
        rangeEfficiency: ledger.rangeEfficiency(entry),
        widthPct: entry.widthPct,
        skew: entry.skew,
        rangePreset: entry.rangePreset,
        openedAt: entry.openedAt,
      });
    }
    return { count: positions.length, maxPositions: config.risk.maxPositions, positions };
  },

  async get_position_detail(args) {
    const positionMint = requireString(args, "position_mint");
    const entry = ledger.getPosition(positionMint);
    const snapshot = await valuePosition(positionMint, { entry });
    return { ...snapshot, ledger: entry, rangeEfficiency: entry ? ledger.rangeEfficiency(entry) : null };
  },

  async get_candidates(args) {
    // The fixed part of the funding cost depends on how big the next position is.
    const balances = await walletBalances().catch(() => null);
    const deploySol = balances ? computeDeploySol(balances.sol) : null;
    const result = await screener.screenPools({ limit: args?.limit, deploySol });
    return {
      count: result.candidates.length,
      scanned: result.scanned,
      candidates: result.candidates,
      // Truncated: the model needs the shape of the rejections, not all of them.
      rejectedSample: result.rejected.slice(0, 15),
      rejectedTotal: result.rejected.length,
      signals: result.signals,
    };
  },

  async inspect_pool(args) {
    return screener.inspectPool(requireString(args, "pool"));
  },

  async get_token_info(args) {
    const query = requireString(args, "query");

    // Jupiter resolves symbols; Orca's token endpoint is mint-only and 400s on a
    // symbol. Resolve first, then ask Orca with the mint it actually understands.
    const jup = await jupiter.tokenInfo(query);
    const mint = jup?.mint ?? (isLikelyMint(query) ? query : null);
    const orcaToken = mint ? await orca.getToken(mint).catch(() => null) : null;

    if (!jup && !orcaToken) return { found: false, query };
    return { found: true, ...jup, orcaRisk: orcaToken?.risk ?? null, orcaTags: orcaToken?.tags ?? [] };
  },

  async get_pool_memory(args) {
    const pool = requireString(args, "pool");
    return { ...poolMemory.getPoolMemory(pool), cooldown: poolMemory.checkCooldown(pool) };
  },

  async get_performance() {
    return lessons.performanceSummary();
  },

  async get_recent_decisions(args) {
    return { decisions: journal.recent(args?.limit ?? 12, args?.kind ?? null) };
  },

  async get_config() {
    return {
      dryRun: config.dryRun,
      risk: config.risk,
      screening: config.screening,
      range: { ...config.range, resolved: resolveRange() },
      management: config.management,
      schedule: config.schedule,
      llm: {
        // Endpoint is useful context; the key is deliberately never returned.
        baseUrl: config.llm.baseUrl,
        keyConfigured: !!config.llm.apiKey,
        screenModel: config.llm.screenModel,
        manageModel: config.llm.manageModel,
        chatModel: config.llm.chatModel,
        temperature: config.llm.temperature,
        maxSteps: config.llm.maxSteps,
      },
      hivemind: hivemind.status(),
      creatorFee: jupiter.creatorFeeParams(),
    };
  },

  async list_lessons(args) {
    return { lessons: lessons.listLessons({ limit: args?.limit ?? 20 }) };
  },

  async open_position(args) {
    const reason = requireString(args, "reason");
    const vetted = await gateOpen(args);
    const { result, entry } = await openAndTrack(vetted, {
      reason,
      risks: Array.isArray(args.risks) ? args.risks : [],
      rejected: Array.isArray(args.rejected) ? args.rejected : [],
    });

    // Retire any signal that pointed at this pool.
    for (const signal of pendingSignals()) {
      if (signal.target === vetted.pool || signal.target === vetted.roles.baseMint) {
        markSignal(signal.id, "acted", `opened position ${result.positionMint}`);
      }
    }

    return {
      opened: true,
      dryRun: result.dryRun,
      positionMint: result.positionMint,
      pair: result.pair,
      deploySol: result.deploySol,
      entryValueUsd: result.entryValueUsd,
      range: {
        widthPct: result.range.widthPct,
        skew: result.range.skew,
        downsidePct: result.range.downsidePct,
        upsidePct: result.range.upsidePct,
        lower: result.range.baseLower,
        upper: result.range.baseUpper,
        ticks: [result.range.tickLower, result.range.tickUpper],
      },
      depositSplit: result.split,
      funding: result.funding,
      tx: result.tx,
      tracked: !!entry,
    };
  },

  async close_position(args) {
    const positionMint = requireString(args, "position_mint");
    const reason = requireString(args, "reason");
    const result = await closeAndSettle({
      positionMint,
      reason,
      closedBy: "agent",
      skipSwap: !!args.skip_swap,
    });
    return {
      closed: true,
      dryRun: result.dryRun,
      positionMint,
      pnlPct: result.record?.pnlPct ?? null,
      pnlUsd: result.record?.pnlUsd ?? null,
      feesUsd: result.record?.feesUsd ?? null,
      minutesHeld: result.record?.minutesHeld ?? null,
      tx: result.tx,
      swap: result.swap,
    };
  },

  async harvest_fees(args) {
    const positionMint = requireString(args, "position_mint");
    // A dry-run "harvest" of a real position would book fees that are still on
    // chain, and the next close would count them a second time.
    requireOwnBook(positionMint);
    const result = await chain.harvestPosition({ positionMint });
    ledger.recordHarvest(positionMint, { feesUsd: result.feesUsd ?? 0, tx: result.tx });
    journal.record({
      kind: "harvest",
      actor: "agent",
      positionMint,
      summary: `Harvested ${result.feesUsd != null ? `$${result.feesUsd.toFixed(2)}` : "fees"}`,
      reason: args.reason ?? null,
      metrics: { feesUsd: result.feesUsd },
    });
    return { harvested: true, ...result };
  },

  async reduce_liquidity(args) {
    const positionMint = requireString(args, "position_mint");
    requireOwnBook(positionMint);
    const reason = requireString(args, "reason");
    const bps = Number(args.bps);
    if (!Number.isFinite(bps) || bps <= 0 || bps > 10_000) refuse("bps must be between 1 and 10000");
    if (bps >= 10_000) refuse("Use close_position to exit fully — it also collects fees and burns the position NFT.");

    const result = await chain.reduceLiquidity({ positionMint, bps });
    journal.record({
      kind: "harvest",
      actor: "agent",
      positionMint,
      summary: `Withdrew ${(bps / 100).toFixed(1)}% of liquidity`,
      reason,
    });
    return { reduced: true, ...result };
  },

  async swap_token(args) {
    const inputMint = requireString(args, "input_mint");
    const outputMint = requireString(args, "output_mint");
    const reason = requireString(args, "reason");
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) refuse("amount must be a positive number");

    const info = await jupiter.tokenInfo(inputMint);
    const decimals = info?.decimals;
    if (decimals == null) refuse(`Cannot resolve decimals for ${inputMint.slice(0, 8)} — refusing to guess an amount`);

    const amountRaw = BigInt(Math.floor(amount * 10 ** decimals));
    const result = await chain.executeSwap({ inputMint, outputMint, amountRaw });
    journal.record({
      kind: "config",
      actor: "agent",
      // A simulated swap must never read like one that moved funds.
      summary: `${result.dryRun ? "[dry run] Would swap" : "Swapped"} ${amount} ${info?.symbol ?? inputMint.slice(0, 6)} → ${outputMint.slice(0, 6)}`,
      reason,
      metrics: { inAmount: result.inAmount, outAmount: result.outAmount, priceImpactPct: result.priceImpactPct },
    });
    return { swapped: true, ...result };
  },

  async set_position_note(args) {
    const positionMint = requireString(args, "position_mint");
    const entry = ledger.setNote(positionMint, requireString(args, "note"));
    if (!entry) refuse("No such tracked position");
    return { updated: true, positionMint, note: entry.note };
  },

  async add_pool_note(args) {
    const pool = requireString(args, "pool");
    poolMemory.addNote(pool, requireString(args, "note"));
    return { saved: true, pool };
  },

  async add_lesson(args) {
    const lesson = lessons.addLesson({
      rule: requireString(args, "rule"),
      tags: Array.isArray(args.tags) ? args.tags : [],
      role: args.role ?? null,
      source: "agent",
    });
    hivemind.pushLesson(lesson).catch(() => null);
    return { saved: true, lesson };
  },

  async block_mint(args) {
    const mint = requireString(args, "mint");
    const reason = requireString(args, "reason");
    blocklist.blockMint(mint, reason);
    journal.record({ kind: "config", actor: "agent", summary: `Blocklisted mint ${mint.slice(0, 8)}`, reason });
    return { blocked: true, mint };
  },

  async update_config(args) {
    const key = requireString(args, "key");
    const reason = requireString(args, "reason");
    let change;
    try {
      change = setTunable(key, args.value);
    } catch (err) {
      // An unknown key or a bad value is the model's mistake, not a failure —
      // surfacing it as a refusal lets it correct and retry.
      refuse(err.message);
    }
    journal.record({
      kind: "config",
      actor: "agent",
      summary: `${key}: ${change.previous} → ${change.value}`,
      reason,
    });
    log("config", `${key}: ${change.previous} → ${change.value} (${reason})`);
    return { updated: true, ...change };
  },

  async record_no_action(args) {
    const reason = requireString(args, "reason");
    journal.record({
      kind: "no_deploy",
      actor: "agent",
      summary: args.best_candidate ? `No action. Closest: ${args.best_candidate}` : "No action taken",
      reason,
    });
    return { recorded: true };
  },
};

/**
 * Execute one tool call.
 *
 * Always resolves. A refusal or an error becomes `{ error }` in the tool result
 * so the model can adapt instead of the whole cycle dying on one bad argument.
 */
export async function executeTool(name, args = {}) {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool "${name}"` };

  try {
    const result = await handler(args);
    return result ?? { ok: true };
  } catch (err) {
    if (err instanceof ToolRefusal) {
      log("gate", `Refused ${name}: ${err.message}`);
      return { error: err.message, refused: true };
    }
    log("tool_error", `${name} failed: ${err.message}`);
    journal.record({ kind: "error", actor: "agent", summary: `${name} failed`, reason: err.message });
    return { error: err.message };
  }
}

export { gateOpen, ToolRefusal };
