/**
 * External signal queue.
 *
 * Anything that can run a command or POST JSON can nominate a pool or token for
 * priority screening — a Telegram message, a webhook, another bot, a cron job.
 * Signals are deduplicated, expire on their own, and are consumed by the
 * screening cycle before it falls back to open-market discovery.
 */

import { createStore, trimList } from "./json-store.js";
import { dataPath } from "../paths.js";

const store = createStore(dataPath("signals.json"), { signals: [] });
const MAX_SIGNALS = 200;
const DEDUP_WINDOW_MS = 10 * 60_000;
const DEFAULT_TTL_MINUTES = 60;

function clean(value, maxLength = 120) {
  const text = String(value ?? "").trim().slice(0, maxLength);
  return text || null;
}

/**
 * Queue a signal. `target` is a pool address or a token mint — the screener
 * resolves whichever it is.
 */
export function addSignal({ target, source = "manual", note = null, ttlMinutes = DEFAULT_TTL_MINUTES }) {
  const address = clean(target, 64);
  if (!address) throw new Error("Signal needs a pool address or token mint");

  return store.update((state) => {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    const duplicate = state.signals.find(
      (signal) => signal.target === address && new Date(signal.at).getTime() > cutoff,
    );
    if (duplicate) return { queued: false, reason: "duplicate within 10m", signal: duplicate };

    const signal = {
      id: `sig_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      target: address,
      source: clean(source, 40) ?? "manual",
      note: clean(note, 240),
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + Math.max(1, ttlMinutes) * 60_000).toISOString(),
      status: "pending",
    };
    state.signals = trimList([...state.signals, signal], MAX_SIGNALS);
    return { queued: true, signal };
  });
}

/** Pending, unexpired signals, newest first. */
export function pendingSignals() {
  const now = Date.now();
  return store
    .read()
    .signals.filter((signal) => signal.status === "pending" && new Date(signal.expiresAt).getTime() > now)
    .reverse();
}

export function markSignal(id, status, note = null) {
  return store.update((state) => {
    const signal = state.signals.find((entry) => entry.id === id);
    if (!signal) return false;
    signal.status = status;
    signal.resolvedAt = new Date().toISOString();
    if (note) signal.resolution = clean(note, 240);
    return true;
  });
}

export function clearSignals() {
  const count = store.read().signals.length;
  store.write({ signals: [] });
  return count;
}

export function listSignals(limit = 30) {
  const signals = store.read().signals;
  return signals.slice(Math.max(0, signals.length - limit)).reverse();
}
