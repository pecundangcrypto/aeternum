/**
 * Derive the numbers a reader actually needs from the raw ledgers.
 *
 * The single most useful thing a liquidity dashboard can show a newcomer is
 * *why* the number moved: fee income and price movement pull in opposite
 * directions, and a position can be up on fees while down overall. Everything
 * here exists to make that split explicit rather than leaving one net figure.
 */

import { config } from "./config.js";
import * as ledger from "./store/positions.js";
import * as journal from "./store/journal.js";
import * as lessons from "./store/lessons.js";
import * as paperAccount from "./store/paper-account.js";
import * as hivemind from "./hivemind/client.js";
import { isPaperMode } from "./chain/solana.js";
import * as watcher from "./watcher.js";
import { creatorFeeParams } from "./market/jupiter.js";
import { headlinePnl } from "./chain/pnl.js";

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function pctOf(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return round((part / whole) * 100, 3);
}

/** How the price sits inside the range, and whether that is comfortable. */
function rangeHealth(position, last) {
  const price = last?.basePrice;
  const lower = position.priceLower;
  const upper = position.priceUpper;

  if (last?.status && last.status !== "priceInRange") {
    const side = last.status === "priceAboveRange" ? "above" : "below";
    const minutesOut = position.outOfRangeSince
      ? Math.round((Date.now() - new Date(position.outOfRangeSince).getTime()) / 60_000)
      : 0;
    return {
      state: "out_of_range",
      side,
      minutesOut,
      minutesLeft: Math.max(0, config.management.outOfRangeWaitMinutes - minutesOut),
      headline: `Out of range (${side})`,
      detail: `Earning nothing. The agent closes it after ${config.management.outOfRangeWaitMinutes} minutes out of range — ${Math.max(0, config.management.outOfRangeWaitMinutes - minutesOut)} to go.`,
    };
  }

  if (!Number.isFinite(price) || !Number.isFinite(lower) || !Number.isFinite(upper)) {
    return { state: "unknown", headline: "Not valued yet", detail: "The watcher has not priced this position yet." };
  }

  const toLower = ((price - lower) / price) * 100;
  const toUpper = ((upper - price) / price) * 100;
  const nearest = Math.min(toLower, toUpper);

  if (nearest < 1.5) {
    return {
      state: "near_edge",
      toLowerPct: round(toLower, 2),
      toUpperPct: round(toUpper, 2),
      headline: "Close to the edge",
      detail: `Price is ${round(nearest, 2)}% from leaving the range. Out of range means no fees at all.`,
    };
  }

  return {
    state: "in_range",
    toLowerPct: round(toLower, 2),
    toUpperPct: round(toUpper, 2),
    headline: "Earning fees",
    detail: `Price is inside the range, ${round(toLower, 2)}% above the floor and ${round(toUpper, 2)}% below the ceiling.`,
  };
}

/** What would make the agent close this position, in plain terms. */
function exitPlan(position, last) {
  const m = config.management;
  const pnl = last?.pnlPct;
  const rows = [
    { label: "Take profit", at: `+${m.takeProfitPct}%`, away: Number.isFinite(pnl) ? round(m.takeProfitPct - pnl, 2) : null },
    { label: "Stop loss", at: `${m.stopLossPct}%`, away: Number.isFinite(pnl) ? round(pnl - m.stopLossPct, 2) : null },
  ];
  if (m.trailingTakeProfit) {
    rows.push({
      label: "Trailing stop",
      at: position.trailingActive
        ? `armed — closes ${m.trailingDropPct}% below the ${round(position.peakPnlPct, 2)}% peak`
        : `arms at +${m.trailingTriggerPct}%`,
      away: position.trailingActive ? round((position.peakPnlPct ?? 0) - m.trailingDropPct - (pnl ?? 0), 2) : null,
      armed: !!position.trailingActive,
    });
  }
  rows.push({ label: "Out of range", at: `${m.outOfRangeWaitMinutes} min` });
  rows.push({ label: "Maximum hold", at: `${m.maxHoldHours} h` });
  return rows;
}

export function buildState() {
  const open = ledger.listOpen();
  const closed = ledger.listClosed(30);
  const paper = isPaperMode();
  const account = paper ? paperAccount.summary() : null;

  const positions = open.map((position) => {
    const last = position.last ?? null;
    const entry = last?.entryValueQuote ?? position.entryValueQuote;

    // The teaching split: net return is fee income plus price movement, exactly.
    const feeContribPct = pctOf(last?.feesQuote, entry);
    const priceContribPct =
      Number.isFinite(last?.valueQuote) && Number.isFinite(entry) ? pctOf(last.valueQuote - entry, entry) : null;

    return {
      positionMint: position.positionMint,
      pair: position.pair,
      pool: position.pool,
      baseSymbol: last?.baseSymbol ?? position.baseSymbol,
      quoteSymbol: last?.quoteSymbol ?? position.quoteSymbol,
      openedAt: position.openedAt,
      minutesHeld: Math.round(ledger.minutesSince(position.openedAt)),
      note: position.note,

      priceLower: position.priceLower,
      priceUpper: position.priceUpper,
      entryPrice: position.entryPrice,
      price: last?.basePrice ?? null,
      rangeProgress: last?.rangeProgress ?? null,
      widthPct: position.widthPct,

      // Net when measured: it is what the exit rules act on and what reaches the wallet.
      pnlPct: last ? headlinePnl(last, config.management.pnlBasis).pct : position.lastPnlPct ?? null,
      positionPnlPct: last?.pnlPct ?? null,
      pnlBasis: last ? headlinePnl(last, config.management.pnlBasis).basis : "position",
      entryCostSol: last?.entryCostSol ?? null,
      pnlUsd: last?.pnlUsd ?? null,
      feeContribPct,
      priceContribPct,
      feesUsd: last?.feesUsd ?? null,
      valueUsd: last?.valueUsd ?? null,
      entryValueUsd: position.entryValueUsd,
      feeAprPct: Number.isFinite(last?.feeApr) ? round(last.feeApr * 100, 0) : null,
      poolFeeAprPct: Number.isFinite(last?.poolFeeApr) ? round(last.poolFeeApr * 100, 0) : null,

      peakPnlPct: position.peakPnlPct,
      trailingActive: !!position.trailingActive,
      timeInRangePct: Number.isFinite(ledger.rangeEfficiency(position))
        ? round(ledger.rangeEfficiency(position) * 100, 0)
        : null,
      pendingExit: position.exitSignal,
      estimated: !!last?.estimated,
      valuedAt: last?.at ?? null,

      health: rangeHealth(position, last),
      exitPlan: exitPlan(position, last),
    };
  });

  // Account-level split. Realised fees come from closed records; unrealised from
  // what each open position has accrued but not collected.
  const realisedFees = closed.reduce((sum, r) => sum + (Number(r.feesUsd) || 0), 0);
  const realisedPnl = closed.reduce((sum, r) => sum + (Number(r.pnlUsd) || 0), 0);
  const openFees = positions.reduce((sum, p) => sum + (Number(p.feesUsd) || 0), 0);
  const openPnl = positions.reduce((sum, p) => sum + (Number(p.pnlUsd) || 0), 0);

  const totalFees = realisedFees + openFees;
  const totalPnl = realisedPnl + openPnl;

  // Equity, not cash. The paper account debits capital when a position opens, so
  // the cash balance alone reads as a catastrophic loss while money is simply at
  // work. Total return has to add back what the open positions are worth.
  const openValueSol = open.reduce(
    (sum, position) => sum + (Number(position.last?.valueSol) || 0) + (Number(position.last?.feesSol) || 0),
    0,
  );
  // The account is funded in SOL but a position is denominated in its pool's quote
  // asset, so converting back to SOL folds in SOL's own price movement. That is a
  // real effect on the balance and a meaningless one for judging the agent, so the
  // two are reported apart rather than silently summed.
  const strategyPnlSol =
    open.reduce((sum, position) => sum + (Number(headlinePnl(position.last, config.management.pnlBasis).sol) || 0), 0) +
    closed.reduce((sum, record) => sum + (Number(record.pnlSol) || 0), 0);

  const equity = account
    ? {
        cashSol: account.currentSol,
        deployedSol: round(openValueSol, 6),
        totalSol: round(account.currentSol + openValueSol, 6),
        startingSol: account.startingSol,
        returnPct:
          account.startingSol > 0
            ? round(((account.currentSol + openValueSol - account.startingSol) / account.startingSol) * 100, 3)
            : null,
        // What the agent's own decisions produced, independent of SOL's price.
        strategyPnlSol: round(strategyPnlSol, 6),
        strategyReturnPct: account.startingSol > 0 ? round((strategyPnlSol / account.startingSol) * 100, 3) : null,
        // Open positions that have not been valued yet would understate equity.
        valued: open.every((position) => Number.isFinite(Number(position.last?.valueSol))),
      }
    : null;

  return {
    at: new Date().toISOString(),
    mode: config.dryRun ? (paper ? "paper" : "dry run") : "live",
    paper,
    account,
    equity,
    startedAt: account?.openedAt ?? null,

    split: {
      totalPnlUsd: round(totalPnl),
      feesUsd: round(totalFees),
      // Everything that is not fee income is price movement, by definition.
      priceUsd: round(totalPnl - totalFees),
      realisedPnlUsd: round(realisedPnl),
      unrealisedPnlUsd: round(openPnl),
    },

    limits: {
      maxPositions: config.risk.maxPositions,
      takeProfitPct: config.management.takeProfitPct,
      stopLossPct: config.management.stopLossPct,
      trailingTriggerPct: config.management.trailingTriggerPct,
      trailingDropPct: config.management.trailingDropPct,
      outOfRangeWaitMinutes: config.management.outOfRangeWaitMinutes,
      maxHoldHours: config.management.maxHoldHours,
      rangePreset: config.range.preset,
      screenIntervalMin: config.schedule.screenIntervalMin,
      manageIntervalMin: config.schedule.manageIntervalMin,
    },
    creatorFee: creatorFeeParams(),

    watcher: watcher.status(),
    hivemind: hivemind.status(),
    positions,
    closed: closed.map((r) => ({
      pair: r.pair,
      closedAt: r.closedAt,
      minutesHeld: r.minutesHeld,
      pnlPct: r.pnlPct,
      pnlUsd: r.pnlUsd,
      feesUsd: r.feesUsd,
      peakPnlPct: r.peakPnlPct,
      timeInRangePct: Number.isFinite(r.rangeEfficiency) ? round(r.rangeEfficiency * 100, 0) : null,
      closeReason: r.closeReason,
      widthPct: r.widthPct,
    })),
    performance: lessons.performanceSummary({ limit: 200 }),
    decisions: journal.recent(15),
    lessons: lessons.listLessons({ limit: 8 }),
  };
}
