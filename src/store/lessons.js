/**
 * Learning engine.
 *
 * Two mechanisms, deliberately separate:
 *
 *   Lessons     — short natural-language rules injected into the system prompt.
 *                 They shape *judgement*: which pools to avoid, what patterns
 *                 preceded bad exits. Written by the agent, by the operator, or
 *                 derived automatically from a close.
 *
 *   Evolution   — arithmetic adjustment of the numeric thresholds in
 *                 user-config.json based on closed-position statistics. It
 *                 shapes *mechanics*, and never touches risk ceilings.
 *
 * Lessons can be wrong and are cheap to drop. Evolution is bounded, logged, and
 * reversible, because it changes what the agent is allowed to buy.
 */

import { createStore, trimList } from "./json-store.js";
import { dataPath } from "../paths.js";
import { config, setTunables } from "../config.js";
import { listClosed } from "./positions.js";
import { log } from "../logger.js";

const store = createStore(dataPath("lessons.json"), { lessons: [], evolutions: [] });

const MAX_LESSONS = 120;
const MAX_EVOLUTIONS = 40;
const MIN_SAMPLES_TO_EVOLVE = 5;

function clean(value, maxLength = 400) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").replace(/[<>`]/g, "").trim().slice(0, maxLength);
  return text || null;
}

function nowIso() {
  return new Date().toISOString();
}

// ─── Lessons ────────────────────────────────────────────────────────────────

export function addLesson({ rule, tags = [], role = null, source = "manual", confidence = null, pool = null, metrics = null }) {
  const text = clean(rule);
  if (!text) throw new Error("A lesson needs a rule");

  return store.update((state) => {
    const duplicate = state.lessons.find((lesson) => lesson.rule.toLowerCase() === text.toLowerCase());
    if (duplicate) {
      duplicate.hits = (duplicate.hits ?? 1) + 1;
      return duplicate;
    }
    const lesson = {
      id: `lsn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      rule: text,
      tags: tags.map((tag) => clean(tag, 40)).filter(Boolean).slice(0, 6),
      role: role ? String(role).toUpperCase() : null,
      source: clean(source, 32) ?? "manual",
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
      pool: clean(pool, 64),
      metrics,
      pinned: false,
      hits: 1,
      createdAt: nowIso(),
    };
    state.lessons = trimList([...state.lessons, lesson], MAX_LESSONS);
    return lesson;
  });
}

export function listLessons({ role = null, limit = 40 } = {}) {
  const wanted = role ? String(role).toUpperCase() : null;
  return store
    .read()
    .lessons.filter((lesson) => !wanted || !lesson.role || lesson.role === wanted)
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export function pinLesson(id, pinned = true) {
  return store.update((state) => {
    const lesson = state.lessons.find((entry) => entry.id === id || entry.rule.startsWith(id));
    if (!lesson) return null;
    lesson.pinned = !!pinned;
    return lesson;
  });
}

export function removeLesson(id) {
  return store.update((state) => {
    const before = state.lessons.length;
    state.lessons = state.lessons.filter((lesson) => lesson.id !== id);
    return state.lessons.length < before;
  });
}

export function clearLessons({ keepPinned = true } = {}) {
  return store.update((state) => {
    const before = state.lessons.length;
    state.lessons = keepPinned ? state.lessons.filter((lesson) => lesson.pinned) : [];
    return before - state.lessons.length;
  });
}

/** Pinned lessons first, then newest — rendered as prompt bullet points. */
export function lessonsForPrompt({ role = "GENERAL", limit = 10 } = {}) {
  const lessons = listLessons({ role, limit });
  if (!lessons.length) return null;
  return lessons.map((lesson) => `- ${lesson.pinned ? "[PINNED] " : ""}${lesson.rule}`).join("\n");
}

// ─── Performance statistics ─────────────────────────────────────────────────

function mean(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return Number((usable.reduce((sum, value) => sum + value, 0) / usable.length).toFixed(4));
}

function groupStats(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (key == null) continue;
    const bucket = groups.get(key) ?? { key, count: 0, wins: 0, pnlPcts: [], feesUsd: 0 };
    bucket.count += 1;
    if (Number(record.pnlPct) > 0) bucket.wins += 1;
    bucket.pnlPcts.push(Number(record.pnlPct));
    bucket.feesUsd += Number(record.feesUsd) || 0;
    groups.set(key, bucket);
  }
  return [...groups.values()]
    .map((bucket) => ({
      key: bucket.key,
      count: bucket.count,
      winRate: Number(((bucket.wins / bucket.count) * 100).toFixed(1)),
      avgPnlPct: mean(bucket.pnlPcts),
      feesUsd: Number(bucket.feesUsd.toFixed(2)),
    }))
    .sort((left, right) => right.count - left.count);
}

export function performanceSummary({ limit = 200 } = {}) {
  const records = listClosed(limit);
  if (!records.length) {
    return { sampleSize: 0, message: "No closed positions yet — nothing to learn from." };
  }

  const pnlPcts = records.map((record) => Number(record.pnlPct));
  const wins = records.filter((record) => Number(record.pnlPct) > 0);

  return {
    sampleSize: records.length,
    winRate: Number(((wins.length / records.length) * 100).toFixed(1)),
    avgPnlPct: mean(pnlPcts),
    medianPnlPct: (() => {
      const sorted = pnlPcts.filter(Number.isFinite).sort((a, b) => a - b);
      if (!sorted.length) return null;
      return Number(sorted[Math.floor(sorted.length / 2)].toFixed(4));
    })(),
    bestPnlPct: pnlPcts.length ? Number(Math.max(...pnlPcts).toFixed(2)) : null,
    worstPnlPct: pnlPcts.length ? Number(Math.min(...pnlPcts).toFixed(2)) : null,
    totalFeesUsd: Number(records.reduce((sum, record) => sum + (Number(record.feesUsd) || 0), 0).toFixed(2)),
    totalPnlUsd: Number(records.reduce((sum, record) => sum + (Number(record.pnlUsd) || 0), 0).toFixed(2)),
    avgMinutesHeld: Math.round(mean(records.map((record) => Number(record.minutesHeld))) ?? 0),
    avgRangeEfficiency: mean(records.map((record) => Number(record.rangeEfficiency))),
    byCloseReason: groupStats(records, (record) => String(record.closeReason ?? "unknown").split(":")[0].trim().slice(0, 40)),
    byRangePreset: groupStats(records, (record) => record.rangePreset),
    byPair: groupStats(records, (record) => record.pair).slice(0, 8),
  };
}

/** Compact performance block for the system prompt. */
export function performanceForPrompt() {
  const stats = performanceSummary({ limit: 120 });
  if (!stats.sampleSize) return null;
  const lines = [
    `Closed positions: ${stats.sampleSize} | win rate ${stats.winRate}% | avg PnL ${stats.avgPnlPct}% | total fees $${stats.totalFeesUsd}`,
    `Avg hold ${stats.avgMinutesHeld}m | avg time in range ${stats.avgRangeEfficiency != null ? `${(stats.avgRangeEfficiency * 100).toFixed(0)}%` : "n/a"}`,
  ];
  const reasons = stats.byCloseReason.slice(0, 4).map((row) => `${row.key} ×${row.count} (${row.winRate}% win)`);
  if (reasons.length) lines.push(`Exit mix: ${reasons.join(", ")}`);
  const presets = stats.byRangePreset.slice(0, 3).map((row) => `${row.key} ${row.avgPnlPct}% avg (n=${row.count})`);
  if (presets.length) lines.push(`Range presets: ${presets.join(", ")}`);
  return lines.join("\n");
}

// ─── Derived lessons ────────────────────────────────────────────────────────

/**
 * Turn one closed position into a lesson when it actually taught something.
 * Silent for ordinary, unremarkable exits — noise in the prompt costs accuracy.
 */
export function deriveLessonFromClose(record) {
  const pnlPct = Number(record.pnlPct);
  const efficiency = Number(record.rangeEfficiency);
  const reason = String(record.closeReason ?? "").toLowerCase();
  const pair = record.pair ?? record.pool?.slice(0, 8) ?? "pool";
  const held = Number(record.minutesHeld);

  const candidates = [];

  if (reason.includes("out of range") && Number.isFinite(held) && held < 45) {
    candidates.push({
      rule: `${pair}: a ${record.widthPct}% wide range left range in ${Math.round(held)}m. On pools this volatile, widen the range or skip.`,
      tags: ["range_width", "out_of_range"],
      role: "SCREENER",
    });
  }

  if (Number.isFinite(efficiency) && efficiency < 0.4 && Number.isFinite(pnlPct) && pnlPct < 0) {
    candidates.push({
      rule: `${pair}: price sat inside the range only ${(efficiency * 100).toFixed(0)}% of the hold and the exit lost ${Math.abs(pnlPct).toFixed(1)}%. Low time-in-range is an early close signal, not something to wait out.`,
      tags: ["range_efficiency"],
      role: "MANAGER",
    });
  }

  if (reason.includes("stop loss") && Number.isFinite(pnlPct)) {
    candidates.push({
      rule: `${pair} hit the stop loss at ${pnlPct.toFixed(1)}% after ${Math.round(held)}m. Check this pool's 24h price move before re-entering — divergence loss outran the fees.`,
      tags: ["stop_loss", "volatility"],
      role: "SCREENER",
    });
  }

  if (reason.includes("trailing") && Number.isFinite(pnlPct) && pnlPct > 0) {
    candidates.push({
      rule: `${pair}: trailing take-profit banked ${pnlPct.toFixed(1)}% from a ${Number(record.peakPnlPct).toFixed(1)}% peak after ${Math.round(held)}m. This pool's profile rewards trailing over holding for the hard target.`,
      tags: ["trailing_tp", "win"],
      role: "MANAGER",
    });
  }

  if (reason.includes("low yield") && Number.isFinite(held)) {
    candidates.push({
      rule: `${pair}: fee yield died after ${Math.round(held)}m. Pools whose volume is front-loaded need an earlier yield check, not a longer hold.`,
      tags: ["low_yield"],
      role: "MANAGER",
    });
  }

  if (!candidates.length) return null;
  const pick = candidates[0];
  return addLesson({
    ...pick,
    source: "derived",
    pool: record.pool,
    metrics: { pnlPct, rangeEfficiency: efficiency, minutesHeld: held, closeReason: record.closeReason },
  });
}

// ─── Threshold evolution ────────────────────────────────────────────────────

function clamp(value, min, max) {
  return Number(Math.min(max, Math.max(min, value)).toFixed(4));
}

/**
 * Adjust numeric thresholds from closed-position statistics.
 *
 * Every proposal is bounded and carries the evidence that produced it. Risk
 * ceilings (maxPositions, maxDeploySol, stopLossPct) are never touched here —
 * those are the operator's decision, not the agent's.
 */
export function evolveThresholds({ dryRun = false } = {}) {
  const stats = performanceSummary({ limit: 200 });
  if (stats.sampleSize < MIN_SAMPLES_TO_EVOLVE) {
    return {
      evolved: false,
      reason: `Need ${MIN_SAMPLES_TO_EVOLVE} closed positions to evolve thresholds, have ${stats.sampleSize}`,
      stats,
    };
  }

  const proposals = [];
  const screening = config.screening;
  const range = config.range;
  const management = config.management;

  const reasonShare = (needle) => {
    const row = stats.byCloseReason.find((entry) => entry.key.toLowerCase().includes(needle));
    return row ? row.count / stats.sampleSize : 0;
  };

  const oorShare = reasonShare("out of range");
  const stopShare = reasonShare("stop loss");
  const lowYieldShare = reasonShare("fee apr");

  // Ranges keep getting left behind → widen the geometry.
  if (oorShare >= 0.4) {
    const next = clamp(range.adaptiveWidthFactor * 1.25, 0.3, 2.5);
    if (next !== range.adaptiveWidthFactor) {
      proposals.push({
        key: "adaptiveRangeWidthFactor",
        from: range.adaptiveWidthFactor,
        to: next,
        why: `${Math.round(oorShare * 100)}% of exits were out-of-range — ranges are too narrow for the pools being picked`,
      });
    }
  }

  // Ranges are far wider than needed → tighten for fee density.
  if (oorShare <= 0.1 && Number.isFinite(stats.avgRangeEfficiency) && stats.avgRangeEfficiency > 0.9 && stats.sampleSize >= 8) {
    const next = clamp(range.adaptiveWidthFactor * 0.9, 0.3, 2.5);
    if (next !== range.adaptiveWidthFactor) {
      proposals.push({
        key: "adaptiveRangeWidthFactor",
        from: range.adaptiveWidthFactor,
        to: next,
        why: `Price stayed in range ${(stats.avgRangeEfficiency * 100).toFixed(0)}% of the time with almost no OOR exits — tightening raises fee density`,
      });
    }
  }

  // Losing more than winning → demand better pools before deploying.
  if (stats.winRate < 40) {
    const nextScore = clamp(screening.minYieldScore + 5, 20, 85);
    if (nextScore !== screening.minYieldScore) {
      proposals.push({
        key: "minYieldScore",
        from: screening.minYieldScore,
        to: nextScore,
        why: `Win rate ${stats.winRate}% — raising the quality bar so fewer marginal pools reach the model`,
      });
    }
    const nextApr = clamp(screening.minFeeApr * 1.15, 0.05, 5);
    if (nextApr !== screening.minFeeApr) {
      proposals.push({
        key: "minFeeApr",
        from: screening.minFeeApr,
        to: nextApr,
        why: `Win rate ${stats.winRate}% — fee APR floor was not high enough to cover divergence loss`,
      });
    }
  }

  // Consistently winning → open the funnel slightly to see more flow.
  if (stats.winRate > 65 && stats.sampleSize >= 10) {
    const nextScore = clamp(screening.minYieldScore - 3, 20, 85);
    if (nextScore !== screening.minYieldScore) {
      proposals.push({
        key: "minYieldScore",
        from: screening.minYieldScore,
        to: nextScore,
        why: `Win rate ${stats.winRate}% over ${stats.sampleSize} closes — the filter can afford to be less strict`,
      });
    }
  }

  // Divergence loss is doing the damage → avoid the most volatile pools.
  if (stopShare >= 0.3) {
    const next = clamp(screening.maxPriceDelta24h * 0.85, 0.1, 3);
    if (next !== screening.maxPriceDelta24h) {
      proposals.push({
        key: "maxPriceDelta24h",
        from: screening.maxPriceDelta24h,
        to: next,
        why: `${Math.round(stopShare * 100)}% of exits were stop losses — capping 24h volatility cuts divergence loss at the source`,
      });
    }
  }

  // Yield dies before the grace period ends → check sooner.
  if (lowYieldShare >= 0.3 && management.yieldGraceMinutes > 30) {
    const next = clamp(management.yieldGraceMinutes * 0.8, 30, 240);
    if (next !== management.yieldGraceMinutes) {
      proposals.push({
        key: "yieldGraceMinutes",
        from: management.yieldGraceMinutes,
        to: Math.round(next),
        why: `${Math.round(lowYieldShare * 100)}% of exits were dead-yield — waiting ${management.yieldGraceMinutes}m wastes capital`,
      });
    }
  }

  // Trailing stops firing barely above the arming threshold → arm later.
  const trailingRow = stats.byCloseReason.find((row) => row.key.toLowerCase().includes("trailing"));
  if (trailingRow && trailingRow.count >= 3 && Number(trailingRow.avgPnlPct) < management.trailingTriggerPct * 0.6) {
    const next = clamp(management.trailingTriggerPct * 1.2, 1, 30);
    if (next !== management.trailingTriggerPct) {
      proposals.push({
        key: "trailingTriggerPct",
        from: management.trailingTriggerPct,
        to: next,
        why: `Trailing exits averaged only ${trailingRow.avgPnlPct}% — arming at ${management.trailingTriggerPct}% closes winners too early`,
      });
    }
  }

  // Trailing stops that never arm. The rule above only catches a trigger set too
  // low; the opposite failure is invisible in the exit mix, because a trailing
  // stop that never armed leaves no "trailing" exits to count. It shows up instead
  // as positions that were in profit, peaked short of the trigger, and closed at a
  // loss — gains the trailing stop existed to keep and never got the chance to.
  const closedRecords = listClosed(200);
  const trigger = management.trailingTriggerPct;
  const reversed = closedRecords.filter((record) => {
    const peak = Number(record.peakPnlPct);
    return Number.isFinite(peak) && peak >= trigger * 0.35 && peak < trigger && Number(record.pnlPct) <= 0;
  });
  if (management.trailingTakeProfit && reversed.length >= 3 && reversed.length / stats.sampleSize >= 0.2) {
    const peaks = reversed.map((record) => Number(record.peakPnlPct)).sort((a, b) => a - b);
    const medianPeak = peaks[Math.floor(peaks.length / 2)];
    // Arm a little below the typical peak, on a half-point grid, never above now.
    const next = clamp(Math.floor(medianPeak * 0.9 * 2) / 2, 1, Math.max(1, trigger - 0.5));
    if (next < trigger) {
      proposals.push({
        key: "trailingTriggerPct",
        from: trigger,
        to: next,
        why: `${reversed.length} of ${stats.sampleSize} closes peaked between ${peaks[0].toFixed(2)}% and ${peaks[peaks.length - 1].toFixed(2)}% — under the ${trigger}% trigger — then closed at a loss. The trailing stop never armed on them`,
      });
      // A drop wider than half the trigger would give back most of what it arms on.
      if (management.trailingDropPct > next / 2) {
        proposals.push({
          key: "trailingDropPct",
          from: management.trailingDropPct,
          to: clamp(next / 2, 0.25, management.trailingDropPct),
          why: `Keeps the give-back proportionate to a ${next}% trigger`,
        });
      }
    }
  }

  if (!proposals.length) {
    return { evolved: false, reason: "Thresholds already match observed performance — no change proposed", stats };
  }

  // One winner per key; the last proposal for a key wins.
  const merged = new Map();
  for (const proposal of proposals) merged.set(proposal.key, proposal);
  const final = [...merged.values()];

  if (dryRun) {
    return { evolved: false, dryRun: true, proposals: final, stats };
  }

  const applied = setTunables(Object.fromEntries(final.map((proposal) => [proposal.key, proposal.to])));
  const evolution = {
    at: nowIso(),
    sampleSize: stats.sampleSize,
    winRate: stats.winRate,
    changes: final,
  };

  store.update((state) => {
    state.evolutions = trimList([...state.evolutions, evolution], MAX_EVOLUTIONS);
  });

  for (const proposal of final) {
    log("evolve", `${proposal.key}: ${proposal.from} → ${proposal.to} (${proposal.why})`);
    addLesson({
      rule: `[self-tuned] ${proposal.key} moved ${proposal.from} → ${proposal.to}. ${proposal.why}`,
      tags: ["self_tuned", proposal.key],
      source: "evolution",
    });
  }

  return { evolved: true, changes: final, applied, stats };
}

export function evolutionHistory(limit = 10) {
  const history = store.read().evolutions;
  return history.slice(Math.max(0, history.length - limit)).reverse();
}
