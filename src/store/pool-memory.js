/**
 * Per-pool memory.
 *
 * The screener keeps rediscovering the same handful of high-yield pools. This
 * store remembers how each one actually treated us — how many times we entered,
 * what the exits looked like, how long the ranges held — and enforces a cooldown
 * after repeated losses so the agent stops paying tuition on the same lesson.
 */

import { createStore } from "./json-store.js";
import { dataPath } from "../paths.js";
import { config } from "../config.js";

const store = createStore(dataPath("pool-memory.json"), { pools: {} });
const MAX_HISTORY = 12;
const MAX_NOTES = 8;

function blank(pool) {
  return {
    pool,
    pair: null,
    deploys: 0,
    closes: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    totalPnlUsd: 0,
    totalFeesUsd: 0,
    lastDeployAt: null,
    lastCloseAt: null,
    cooldownUntil: null,
    notes: [],
    history: [],
  };
}

export function getPoolMemory(pool) {
  return store.read().pools[pool] ?? blank(pool);
}

export function recordDeploy(pool, { pair, rangePreset, widthPct, entryValueUsd }) {
  return store.update((state) => {
    const memory = (state.pools[pool] ??= blank(pool));
    memory.pair = pair ?? memory.pair;
    memory.deploys += 1;
    memory.lastDeployAt = new Date().toISOString();
    memory.history = [
      ...memory.history,
      { at: memory.lastDeployAt, kind: "open", rangePreset, widthPct, entryValueUsd },
    ].slice(-MAX_HISTORY);
    return memory;
  });
}

export function recordClose(pool, record) {
  return store.update((state) => {
    const memory = (state.pools[pool] ??= blank(pool));
    const pnlUsd = Number(record.pnlUsd) || 0;
    const win = Number(record.pnlPct) > 0;

    memory.pair = record.pair ?? memory.pair;
    memory.closes += 1;
    memory.wins += win ? 1 : 0;
    memory.losses += win ? 0 : 1;
    memory.consecutiveLosses = win ? 0 : memory.consecutiveLosses + 1;
    memory.totalPnlUsd = Number((memory.totalPnlUsd + pnlUsd).toFixed(4));
    memory.totalFeesUsd = Number((memory.totalFeesUsd + (Number(record.feesUsd) || 0)).toFixed(4));
    memory.lastCloseAt = new Date().toISOString();
    memory.history = [
      ...memory.history,
      {
        at: memory.lastCloseAt,
        kind: "close",
        pnlPct: record.pnlPct,
        feesUsd: record.feesUsd,
        minutesHeld: record.minutesHeld,
        reason: record.closeReason,
        rangeEfficiency: record.rangeEfficiency,
      },
    ].slice(-MAX_HISTORY);

    if (memory.consecutiveLosses >= config.management.reentryCooldownLosses) {
      memory.cooldownUntil = new Date(Date.now() + config.management.reentryCooldownHours * 3_600_000).toISOString();
    }
    return memory;
  });
}

/** `{ blocked, reason }` — whether the screener may enter this pool right now. */
export function checkCooldown(pool) {
  const memory = getPoolMemory(pool);
  if (!memory.cooldownUntil) return { blocked: false };
  const until = new Date(memory.cooldownUntil).getTime();
  if (Number.isNaN(until) || until <= Date.now()) return { blocked: false };
  const hoursLeft = ((until - Date.now()) / 3_600_000).toFixed(1);
  return {
    blocked: true,
    reason: `Pool on cooldown for ${hoursLeft}h after ${memory.consecutiveLosses} consecutive losing exits`,
    until: memory.cooldownUntil,
  };
}

export function addNote(pool, note) {
  const text = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!text) throw new Error("Note is empty");
  return store.update((state) => {
    const memory = (state.pools[pool] ??= blank(pool));
    memory.notes = [...memory.notes, { at: new Date().toISOString(), note: text }].slice(-MAX_NOTES);
    return memory;
  });
}

export function clearCooldown(pool) {
  return store.update((state) => {
    const memory = state.pools[pool];
    if (!memory) return false;
    memory.cooldownUntil = null;
    memory.consecutiveLosses = 0;
    return true;
  });
}

/** Pools that have actually hurt us — surfaced to the screener as context. */
export function troubledPools(limit = 6) {
  return Object.values(store.read().pools)
    .filter((memory) => memory.losses > 0)
    .sort((left, right) => left.totalPnlUsd - right.totalPnlUsd)
    .slice(0, limit)
    .map((memory) => ({
      pool: memory.pool,
      pair: memory.pair,
      closes: memory.closes,
      losses: memory.losses,
      totalPnlUsd: memory.totalPnlUsd,
      cooldownUntil: memory.cooldownUntil,
    }));
}
