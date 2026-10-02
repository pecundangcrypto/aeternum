/**
 * Permanent blocklist for token mints and pools.
 *
 * Separate from the pool cooldown: a cooldown expires, a blocklist entry does
 * not. Rugs, honeypots and fee-on-transfer surprises go here.
 */

import { createStore } from "./json-store.js";
import { dataPath } from "../paths.js";
import { config } from "../config.js";

const store = createStore(dataPath("blocklist.json"), { mints: {}, pools: {} });

function clean(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Address is required");
  return text;
}

export function blockMint(mint, reason = "manual") {
  const key = clean(mint);
  store.update((state) => {
    state.mints[key] = { reason: String(reason).slice(0, 240), at: new Date().toISOString() };
  });
  return key;
}

export function unblockMint(mint) {
  return store.update((state) => {
    const key = clean(mint);
    if (!state.mints[key]) return false;
    delete state.mints[key];
    return true;
  });
}

export function blockPool(pool, reason = "manual") {
  const key = clean(pool);
  store.update((state) => {
    state.pools[key] = { reason: String(reason).slice(0, 240), at: new Date().toISOString() };
  });
  return key;
}

export function unblockPool(pool) {
  return store.update((state) => {
    const key = clean(pool);
    if (!state.pools[key]) return false;
    delete state.pools[key];
    return true;
  });
}

/** `{ blocked, reason }` for a candidate. Also honours config.screening.blockedMints. */
export function checkBlocked({ pool, mints = [] }) {
  const state = store.read();
  if (pool && state.pools[pool]) {
    return { blocked: true, reason: `Pool blocklisted: ${state.pools[pool].reason}` };
  }
  for (const mint of mints.filter(Boolean)) {
    if (state.mints[mint]) return { blocked: true, reason: `Mint ${mint.slice(0, 8)} blocklisted: ${state.mints[mint].reason}` };
    if (config.screening.blockedMints.includes(mint)) {
      return { blocked: true, reason: `Mint ${mint.slice(0, 8)} blocked by config.blockedMints` };
    }
  }
  return { blocked: false };
}

export function listBlocked() {
  const state = store.read();
  return {
    mints: Object.entries(state.mints).map(([mint, meta]) => ({ mint, ...meta })),
    pools: Object.entries(state.pools).map(([pool, meta]) => ({ pool, ...meta })),
    configMints: config.screening.blockedMints,
  };
}
