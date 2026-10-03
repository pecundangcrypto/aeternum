/**
 * Position ledger and exit engine.
 *
 * On-chain accounts say what a position *is*; they say nothing about why it was
 * opened, what it cost, or how well it has done. This ledger holds that half —
 * entry value, range geometry, peak PnL, out-of-range dwell time — and owns the
 * deterministic exit rules that run on it.
 *
 * Exits are intentionally NOT left to the model. The LLM chooses what to open;
 * arithmetic decides when to close, so a bad completion can never sit on a
 * losing position.
 */

import { createStore, trimList } from "./json-store.js";
import { dataPath } from "../paths.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { headlinePnl } from "../chain/pnl.js";

const store = createStore(dataPath("positions.json"), {
  positions: {},
  closed: [],
  events: [],
});

const MAX_CLOSED = 400;
const MAX_EVENTS = 60;
const MAX_NOTE = 240;

function clean(value, maxLength = MAX_NOTE) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").replace(/[<>`]/g, "").trim().slice(0, maxLength);
  return text || null;
}

function nowIso() {
  return new Date().toISOString();
}

function minutesSince(iso) {
  if (!iso) return 0;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 60_000);
}

/** Record a freshly opened position. Keyed by its position mint. */
export function openPosition(entry) {
  const key = entry.positionMint;
  store.update((state) => {
    state.positions[key] = {
      positionMint: key,
      pool: entry.pool,
      pair: entry.pair ?? null,
      baseMint: entry.baseMint ?? null,
      quoteMint: entry.quoteMint ?? null,
      baseSymbol: entry.baseSymbol ?? null,
      quoteSymbol: entry.quoteSymbol ?? null,

      tickLower: entry.tickLower,
      tickUpper: entry.tickUpper,
      priceLower: entry.priceLower,
      priceUpper: entry.priceUpper,
      entryPrice: entry.entryPrice,
      rangePreset: entry.rangePreset ?? null,
      widthPct: entry.widthPct ?? null,
      skew: entry.skew ?? null,

      deploySol: entry.deploySol ?? null,
      entryValueUsd: entry.entryValueUsd ?? null,
      entryValueSol: entry.entryValueSol ?? null,
      // PnL is measured against this, in the pool's quote asset, with no oracle.
      entryValueQuote: entry.entryValueQuote ?? null,
      quoteSymbolForPnl: entry.quoteSymbol ?? null,
      entrySnapshot: entry.entrySnapshot ?? null,
      openedAt: nowIso(),
      openTx: entry.openTx ?? null,
      note: clean(entry.note),
      // Present only for paper positions: the simulated liquidity and accrued fees.
      paper: entry.paper ?? null,
      // Live only: what opening it really cost, measured from the wallet. Drives net PnL.
      cost: entry.cost ?? null,

      // Exit-engine state.
      peakPnlPct: 0,
      pendingPeakPct: null,
      pendingPeakTicks: 0,
      trailingActive: false,
      outOfRangeSince: null,
      exitSignal: null,
      exitSignalTicks: 0,
      harvestedUsd: 0,
      harvestCount: 0,
      lastPnlPct: null,
      lastSeenAt: nowIso(),
    };
    state.events = trimList([...state.events, { at: nowIso(), kind: "open", position: key, pair: entry.pair ?? null }], MAX_EVENTS);
  });
  log("ledger", `Tracking position ${key} (${entry.pair ?? "?"})`);
  return store.read().positions[key];
}

export function listOpen() {
  return Object.values(store.read().positions);
}

export function getPosition(positionMint) {
  return store.read().positions[positionMint] ?? null;
}

export function isTracked(positionMint) {
  return !!store.read().positions[positionMint];
}

/** Shallow-merge fields into a tracked position. */
export function updatePosition(positionMint, patch) {
  return store.update((state) => {
    const entry = state.positions[positionMint];
    if (!entry) return null;
    Object.assign(entry, patch, { lastSeenAt: nowIso() });
    return entry;
  });
}

export function setNote(positionMint, note) {
  return updatePosition(positionMint, { note: clean(note) });
}

/** Drop a position from the ledger without recording a close (e.g. closed elsewhere). */
export function forgetPosition(positionMint, reason = "untracked") {
  return store.update((state) => {
    if (!state.positions[positionMint]) return false;
    delete state.positions[positionMint];
    state.events = trimList([...state.events, { at: nowIso(), kind: "forget", position: positionMint, reason }], MAX_EVENTS);
    return true;
  });
}

/**
 * Move a position into the closed ledger.
 * Returns the closed record, which is what feeds the learning engine.
 */
export function recordClose(positionMint, outcome) {
  return store.update((state) => {
    const entry = state.positions[positionMint];
    if (!entry) return null;
    delete state.positions[positionMint];

    const record = {
      positionMint,
      pool: entry.pool,
      pair: entry.pair,
      baseMint: entry.baseMint,
      quoteMint: entry.quoteMint,
      rangePreset: entry.rangePreset,
      widthPct: entry.widthPct,
      skew: entry.skew,
      entryPrice: entry.entryPrice,
      priceLower: entry.priceLower,
      priceUpper: entry.priceUpper,
      entryValueUsd: entry.entryValueUsd,
      entryValueSol: entry.entryValueSol,
      entryValueQuote: entry.entryValueQuote ?? null,
      entrySnapshot: entry.entrySnapshot ?? null,
      openedAt: entry.openedAt,
      closedAt: nowIso(),
      minutesHeld: Math.round(minutesSince(entry.openedAt)),
      peakPnlPct: entry.peakPnlPct ?? 0,
      harvestedUsd: entry.harvestedUsd ?? 0,

      exitPrice: outcome.exitPrice ?? null,
      exitValueUsd: outcome.exitValueUsd ?? null,
      exitValueSol: outcome.exitValueSol ?? null,
      feesUsd: outcome.feesUsd ?? 0,
      feesSol: outcome.feesSol ?? 0,
      pnlUsd: outcome.pnlUsd ?? null,
      pnlSol: outcome.pnlSol ?? null,
      pnlPct: outcome.pnlPct ?? null,
      grossPnlPct: outcome.grossPnlPct ?? null,
      netPnlPct: outcome.netPnlPct ?? null,
      pnlBasis: outcome.pnlBasis ?? "position",
      closeReason: clean(outcome.reason, 300) ?? "manual",
      closedBy: outcome.closedBy ?? "agent",
      closeTx: outcome.tx ?? null,
      // Fraction of the hold the price actually spent inside the range, as seen
      // by the watcher. The single best predictor of whether a range was sized
      // correctly.
      rangeEfficiency: outcome.rangeEfficiency ?? null,
      exitSnapshot: outcome.exitSnapshot ?? null,
    };

    state.closed = trimList([...state.closed, record], MAX_CLOSED);
    state.events = trimList(
      [...state.events, { at: nowIso(), kind: "close", position: positionMint, pair: entry.pair, pnlPct: record.pnlPct }],
      MAX_EVENTS,
    );
    return record;
  });
}

export function listClosed(limit = 50) {
  const closed = store.read().closed;
  return closed.slice(Math.max(0, closed.length - limit)).reverse();
}

export function recentEvents(limit = 10) {
  const events = store.read().events;
  return events.slice(Math.max(0, events.length - limit)).reverse();
}

// ─── Exit engine ────────────────────────────────────────────────────────────

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive ticks stay
 * above the current peak.
 *
 * Without this, one noisy price read inflates the peak and immediately arms a
 * trailing stop that then fires on the *correct* next read — closing a healthy
 * position at a loss.
 */
export function confirmPeak(positionMint, candidatePct, confirmTicks = config.management.confirmTicks) {
  return store.update((state) => {
    const entry = state.positions[positionMint];
    if (!entry || !Number.isFinite(candidatePct)) return false;

    const peak = entry.peakPnlPct ?? 0;
    if (candidatePct <= peak) {
      entry.pendingPeakPct = null;
      entry.pendingPeakTicks = 0;
      return false;
    }

    if (entry.pendingPeakPct != null && candidatePct >= entry.pendingPeakPct) {
      entry.pendingPeakTicks = (entry.pendingPeakTicks ?? 0) + 1;
      entry.pendingPeakPct = candidatePct;
    } else {
      entry.pendingPeakPct = candidatePct;
      entry.pendingPeakTicks = 1;
    }

    if (entry.pendingPeakTicks < Math.max(1, confirmTicks)) return false;

    entry.peakPnlPct = Number(Math.max(peak, entry.pendingPeakPct).toFixed(4));
    entry.pendingPeakPct = null;
    entry.pendingPeakTicks = 0;
    return true;
  });
}

/**
 * Require the same exit signal on `confirmTicks` consecutive evaluations before
 * acting. Returns true when the signal is confirmed and the caller should close.
 */
export function confirmExitSignal(positionMint, signal, confirmTicks = config.management.confirmTicks) {
  return store.update((state) => {
    const entry = state.positions[positionMint];
    if (!entry) return false;

    if (!signal) {
      entry.exitSignal = null;
      entry.exitSignalTicks = 0;
      return false;
    }

    if (entry.exitSignal === signal) {
      entry.exitSignalTicks = (entry.exitSignalTicks ?? 0) + 1;
    } else {
      entry.exitSignal = signal;
      entry.exitSignalTicks = 1;
    }

    return entry.exitSignalTicks >= Math.max(1, confirmTicks);
  });
}

/** Track how long a position has been out of range; clears on re-entry. */
export function trackRangeStatus(positionMint, status) {
  return store.update((state) => {
    const entry = state.positions[positionMint];
    if (!entry) return null;

    const inRange = status === "priceInRange";
    if (inRange) {
      entry.outOfRangeSince = null;
      entry.inRangeTicks = (entry.inRangeTicks ?? 0) + 1;
    } else {
      entry.outOfRangeSince ??= nowIso();
      entry.outOfRangeTicks = (entry.outOfRangeTicks ?? 0) + 1;
    }
    entry.rangeStatus = status;
    return {
      inRange,
      outOfRangeMinutes: inRange ? 0 : minutesSince(entry.outOfRangeSince),
    };
  });
}

/** Share of observed ticks the price spent inside the range. */
export function rangeEfficiency(entry) {
  const inRange = entry.inRangeTicks ?? 0;
  const outOfRange = entry.outOfRangeTicks ?? 0;
  const total = inRange + outOfRange;
  if (!total) return null;
  return Number((inRange / total).toFixed(4));
}

/**
 * Decide what to do with one position from a live snapshot.
 *
 * Returns `{ action, reason, detail }` where action is:
 *   "close"   — an exit rule fired and was confirmed
 *   "harvest" — enough fees have accrued to be worth a claim
 *   "hold"    — nothing to do
 *
 * Rules are ordered by severity: capital preservation first, profit taking
 * second, opportunity cost last.
 */
export function evaluateExit(positionMint, live) {
  const entry = getPosition(positionMint);
  if (!entry) return { action: "hold", reason: "not tracked" };

  const mgmt = config.management;
  // Net PnL — after what it cost to get in and will cost to get out — when the
  // entry cost was measured. Judging exits on the gross figure would let a
  // trailing stop "take profit" at a level that is a loss in the wallet.
  const pnlPct = headlinePnl(live, config.management.pnlBasis).pct;
  const hasPnl = Number.isFinite(pnlPct);
  const heldMinutes = minutesSince(entry.openedAt);

  const range = trackRangeStatus(positionMint, live.status) ?? { inRange: true, outOfRangeMinutes: 0 };

  if (hasPnl) {
    confirmPeak(positionMint, pnlPct);
    updatePosition(positionMint, { lastPnlPct: Number(pnlPct.toFixed(4)) });
  }

  const fresh = getPosition(positionMint);
  const peak = fresh.peakPnlPct ?? 0;

  // Arm the trailing stop once the position has banked enough to be worth
  // protecting. Arming is sticky — a dip must not disarm it.
  if (mgmt.trailingTakeProfit && !fresh.trailingActive && peak >= mgmt.trailingTriggerPct) {
    updatePosition(positionMint, { trailingActive: true });
    log("exit", `${entry.pair ?? positionMint}: trailing armed at peak ${peak.toFixed(2)}%`);
  }

  const armed = getPosition(positionMint).trailingActive;

  const fire = (signal, reason, detail = {}) => {
    const confirmed = confirmExitSignal(positionMint, signal);
    if (!confirmed) {
      return { action: "hold", reason: `${reason} (awaiting confirmation)`, pending: signal, detail };
    }
    return { action: "close", signal, reason, detail };
  };

  // 1. Stop loss — hard floor on total position PnL.
  if (hasPnl && pnlPct <= mgmt.stopLossPct) {
    return fire("stop_loss", `Stop loss: PnL ${pnlPct.toFixed(2)}% at or below ${mgmt.stopLossPct}%`, { pnlPct });
  }

  // 2. Trailing take-profit — give back at most `trailingDropPct` from the peak.
  if (hasPnl && armed) {
    const drop = peak - pnlPct;
    if (drop >= mgmt.trailingDropPct) {
      return fire(
        "trailing_tp",
        `Trailing TP: peak ${peak.toFixed(2)}% → ${pnlPct.toFixed(2)}% (gave back ${drop.toFixed(2)}% ≥ ${mgmt.trailingDropPct}%)`,
        { peakPnlPct: peak, pnlPct, dropPct: Number(drop.toFixed(2)) },
      );
    }
  }

  // 3. Hard take-profit ceiling.
  if (hasPnl && pnlPct >= mgmt.takeProfitPct) {
    return fire("take_profit", `Take profit: PnL ${pnlPct.toFixed(2)}% reached ${mgmt.takeProfitPct}%`, { pnlPct });
  }

  // 4. Out of range — a Whirlpool position outside its range earns nothing and
  //    is 100% in the losing side of the pair.
  if (!range.inRange && range.outOfRangeMinutes >= mgmt.outOfRangeWaitMinutes) {
    const side = live.status === "priceAboveRange" ? "above" : "below";
    return fire(
      "out_of_range",
      `Out of range (${side}) for ${Math.round(range.outOfRangeMinutes)}m ≥ ${mgmt.outOfRangeWaitMinutes}m — earning no fees`,
      { status: live.status, outOfRangeMinutes: Math.round(range.outOfRangeMinutes) },
    );
  }

  // 5. Maximum hold — stale capital, regardless of PnL.
  if (heldMinutes >= mgmt.maxHoldHours * 60) {
    return fire("max_hold", `Held ${(heldMinutes / 60).toFixed(1)}h ≥ max ${mgmt.maxHoldHours}h`, { heldHours: Number((heldMinutes / 60).toFixed(1)) });
  }

  // 6. Dead yield after a grace period — the pool stopped paying.
  if (heldMinutes >= mgmt.yieldGraceMinutes && Number.isFinite(live.feeApr) && live.feeApr < mgmt.minFeeAprToHold) {
    return fire(
      "low_yield",
      `Fee APR ${(live.feeApr * 100).toFixed(1)}% below floor ${(mgmt.minFeeAprToHold * 100).toFixed(1)}% after ${Math.round(heldMinutes)}m`,
      { feeApr: live.feeApr },
    );
  }

  // Nothing fired — clear any half-formed signal so it has to re-confirm.
  confirmExitSignal(positionMint, null);

  if (Number.isFinite(live.feesUsd) && live.feesUsd >= mgmt.autoHarvestFeesUsd) {
    return {
      action: "harvest",
      reason: `Uncollected fees $${live.feesUsd.toFixed(2)} ≥ $${mgmt.autoHarvestFeesUsd}`,
      detail: { feesUsd: live.feesUsd },
    };
  }

  return {
    action: "hold",
    reason: hasPnl
      ? `PnL ${pnlPct.toFixed(2)}% | peak ${peak.toFixed(2)}%${armed ? " | trailing armed" : ""} | ${range.inRange ? "in range" : `out of range ${Math.round(range.outOfRangeMinutes)}m`}`
      : "no live PnL available",
    detail: { pnlPct, peakPnlPct: peak, trailingActive: armed, inRange: range.inRange },
  };
}

export function recordHarvest(positionMint, { feesUsd = 0, tx = null } = {}) {
  return store.update((state) => {
    const entry = state.positions[positionMint];
    if (!entry) return null;
    entry.harvestedUsd = Number(((entry.harvestedUsd ?? 0) + (feesUsd || 0)).toFixed(4));
    entry.harvestCount = (entry.harvestCount ?? 0) + 1;
    entry.lastHarvestAt = nowIso();
    state.events = trimList([...state.events, { at: nowIso(), kind: "harvest", position: positionMint, feesUsd, tx }], MAX_EVENTS);
    return entry;
  });
}

/** Compact ledger summary injected into every agent prompt. */
export function ledgerSummary() {
  const state = store.read();
  const open = Object.values(state.positions);
  const closed = state.closed;
  const wins = closed.filter((record) => Number(record.pnlPct) > 0).length;

  return {
    openCount: open.length,
    maxPositions: config.risk.maxPositions,
    slotsFree: Math.max(0, config.risk.maxPositions - open.length),
    closedCount: closed.length,
    winRate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : null,
    openPositions: open.map((entry) => ({
      positionMint: entry.positionMint,
      pair: entry.pair,
      heldMinutes: Math.round(minutesSince(entry.openedAt)),
      lastPnlPct: entry.lastPnlPct,
      peakPnlPct: entry.peakPnlPct,
      trailingActive: entry.trailingActive,
      rangeStatus: entry.rangeStatus ?? null,
      note: entry.note,
    })),
  };
}

export { minutesSince };
