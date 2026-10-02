/**
 * Hivemind — optional shared learning between independent agents.
 *
 * One agent only ever learns from its own closes, which is a slow and expensive
 * curriculum. Hivemind lets a group of operators pool the *conclusions*: derived
 * lessons, closed-position outcomes, and threshold presets that are working.
 *
 * Design constraints, in order of importance:
 *
 *   1. **Off by default.** There is no built-in server. `hivemindUrl` must be set
 *      explicitly, so no data leaves the machine unless the operator chose a
 *      destination. Run your own with `npm run hivemind:serve`.
 *   2. **Never send anything that identifies the wallet.** No addresses, no
 *      balances, no signatures, no position mints. What ships is pool addresses,
 *      pair names, percentages and durations.
 *   3. **Never block the agent.** Every call is wrapped; a dead server produces a
 *      warning and nothing else.
 *   4. **Inbound data is untrusted.** Shared lessons are injected into prompts as
 *      reports from other operators, explicitly not as instructions.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createStore } from "../store/json-store.js";
import { dataPath, rootPath } from "../paths.js";
import { config, persistUserConfigKey } from "../config.js";
import { log } from "../logger.js";

const cache = createStore(dataPath("hivemind-cache.json"), {
  lessons: [],
  presets: [],
  pulledAt: null,
  pushed: {},
});

const HEARTBEAT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SHARED_LESSONS = 40;

let heartbeatTimer = null;

function version() {
  try {
    return JSON.parse(fs.readFileSync(rootPath("package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const AGENT_VERSION = version();

function sanitize(value, maxLength = 300) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").replace(/[<>`]/g, "").trim().slice(0, maxLength);
  return text || null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : null;
}

export function isEnabled() {
  return !!config.hivemind.url;
}

/**
 * Stable pseudonymous id for this agent.
 * Random, persisted, and unrelated to the wallet — the swarm can attribute a
 * track record without ever learning whose wallet it is.
 */
export function agentId() {
  if (config.hivemind.agentId) return config.hivemind.agentId;
  const id = `agent_${crypto.randomBytes(10).toString("hex")}`;
  config.hivemind.agentId = id;
  persistUserConfigKey("hivemindAgentId", id);
  log("hivemind", `Generated agent id ${id}`);
  return id;
}

async function request(path, { method = "GET", body = null, query = {} } = {}) {
  if (!isEnabled()) return null;

  const url = new URL(path.replace(/^\//, ""), config.hivemind.url.endsWith("/") ? config.hivemind.url : `${config.hivemind.url}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      ...(config.hivemind.apiKey ? { "x-api-key": config.hivemind.apiKey } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error ?? `Hivemind ${response.status}`);
  return payload;
}

// ─── Inbound ────────────────────────────────────────────────────────────────

function normalizeSharedLesson(raw) {
  const rule = sanitize(raw?.rule, 400);
  if (!rule) return null;
  return {
    id: sanitize(raw.id, 64) ?? `shared_${crypto.randomBytes(4).toString("hex")}`,
    rule,
    role: raw.role ? String(raw.role).toUpperCase().slice(0, 16) : null,
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => sanitize(tag, 32)).filter(Boolean).slice(0, 6) : [],
    // How many independent agents reported the same thing. The only trust signal
    // available, so it drives ordering.
    agreement: Number.isFinite(Number(raw.agreement)) ? Number(raw.agreement) : 1,
    score: numberOrNull(raw.score),
    at: sanitize(raw.at, 40) ?? new Date().toISOString(),
  };
}

export async function pullLessons({ limit = MAX_SHARED_LESSONS } = {}) {
  if (!isEnabled()) return null;
  try {
    const payload = await request("v1/lessons", { query: { agentId: agentId(), limit } });
    const lessons = (Array.isArray(payload?.lessons) ? payload.lessons : [])
      .map(normalizeSharedLesson)
      .filter(Boolean)
      .slice(0, MAX_SHARED_LESSONS);
    cache.update((state) => {
      state.lessons = lessons;
      state.pulledAt = new Date().toISOString();
    });
    log("hivemind", `Pulled ${lessons.length} shared lesson${lessons.length === 1 ? "" : "s"}`);
    return lessons;
  } catch (err) {
    log("hivemind_warn", `Lesson pull failed: ${err.message}`);
    return null;
  }
}

export async function pullPresets() {
  if (!isEnabled()) return null;
  try {
    const payload = await request("v1/presets", { query: { agentId: agentId() } });
    const presets = Array.isArray(payload?.presets) ? payload.presets.slice(0, 10) : [];
    cache.update((state) => {
      state.presets = presets;
      state.pulledAt = new Date().toISOString();
    });
    return presets;
  } catch (err) {
    log("hivemind_warn", `Preset pull failed: ${err.message}`);
    return null;
  }
}

/**
 * Shared lessons rendered for the prompt, best-agreed first.
 *
 * Labelled as external reports on purpose: these strings came from other
 * machines, and the model must weigh them rather than obey them.
 */
export function sharedLessonsForPrompt({ role = "GENERAL", limit = 5 } = {}) {
  if (config.hivemind.pullMode === "manual" && !isEnabled()) return null;
  const wanted = String(role).toUpperCase();
  const lessons = cache
    .read()
    .lessons.filter((lesson) => !lesson.role || lesson.role === wanted || wanted === "GENERAL")
    .sort((left, right) => right.agreement - left.agreement)
    .slice(0, limit);
  if (!lessons.length) return null;
  return lessons
    .map((lesson) => `- [${lesson.agreement} agent${lesson.agreement === 1 ? "" : "s"} agree] ${lesson.rule}`)
    .join("\n");
}

export function cachedPresets() {
  return cache.read().presets;
}

// ─── Outbound ───────────────────────────────────────────────────────────────

function alreadyPushed(key) {
  return !!cache.read().pushed[key];
}

function markPushed(key) {
  cache.update((state) => {
    state.pushed[key] = new Date().toISOString();
    // Keep the dedup map from growing without bound.
    const keys = Object.keys(state.pushed);
    if (keys.length > 500) {
      for (const stale of keys.slice(0, keys.length - 500)) delete state.pushed[stale];
    }
  });
}

export async function pushLesson(lesson) {
  if (!isEnabled() || !config.hivemind.share) return null;
  const rule = sanitize(lesson?.rule, 400);
  if (!rule) return null;

  const key = `lesson:${lesson.id ?? rule.slice(0, 40)}`;
  if (alreadyPushed(key)) return null;

  try {
    const result = await request("v1/lessons", {
      method: "POST",
      body: {
        agentId: agentId(),
        version: AGENT_VERSION,
        label: sanitize(config.hivemind.label, 40),
        lesson: {
          id: sanitize(lesson.id, 64),
          rule,
          role: lesson.role ?? null,
          tags: Array.isArray(lesson.tags) ? lesson.tags.slice(0, 6) : [],
          source: sanitize(lesson.source, 32),
          // Pool addresses are public data; nothing here ties back to a wallet.
          pool: sanitize(lesson.pool, 64),
          metrics: lesson.metrics
            ? {
                pnlPct: numberOrNull(lesson.metrics.pnlPct),
                rangeEfficiency: numberOrNull(lesson.metrics.rangeEfficiency),
                minutesHeld: numberOrNull(lesson.metrics.minutesHeld),
                closeReason: sanitize(lesson.metrics.closeReason, 120),
              }
            : null,
        },
      },
    });
    markPushed(key);
    return result;
  } catch (err) {
    log("hivemind_warn", `Lesson push failed: ${err.message}`);
    return null;
  }
}

/**
 * Share a closed position as an outcome record.
 * Percentages and durations only — no value, no wallet, no signature.
 */
export async function pushOutcome(record) {
  if (!isEnabled() || !config.hivemind.share) return null;

  const key = `close:${record.pool}:${record.closedAt}`;
  if (alreadyPushed(key)) return null;

  try {
    const result = await request("v1/performance", {
      method: "POST",
      body: {
        agentId: agentId(),
        version: AGENT_VERSION,
        label: sanitize(config.hivemind.label, 40),
        outcome: {
          pool: sanitize(record.pool, 64),
          pair: sanitize(record.pair, 40),
          baseMint: sanitize(record.baseMint, 64),
          rangePreset: sanitize(record.rangePreset, 32),
          widthPct: numberOrNull(record.widthPct),
          skew: numberOrNull(record.skew),
          pnlPct: numberOrNull(record.pnlPct),
          feeAprRealised:
            record.minutesHeld && record.entryValueUsd
              ? numberOrNull(((record.feesUsd ?? 0) / record.entryValueUsd) * (525_600 / record.minutesHeld))
              : null,
          minutesHeld: numberOrNull(record.minutesHeld),
          rangeEfficiency: numberOrNull(record.rangeEfficiency),
          closeReason: sanitize(record.closeReason, 160),
          entrySnapshot: record.entrySnapshot
            ? {
                tvlUsd: numberOrNull(record.entrySnapshot.tvlUsd),
                feeApr: numberOrNull(record.entrySnapshot.feeApr),
                volumeTvlRatio: numberOrNull(record.entrySnapshot.volumeTvlRatio),
                tickSpacing: record.entrySnapshot.tickSpacing ?? null,
              }
            : null,
        },
      },
    });
    markPushed(key);
    return result;
  } catch (err) {
    log("hivemind_warn", `Outcome push failed: ${err.message}`);
    return null;
  }
}

async function heartbeat(reason = "heartbeat") {
  if (!isEnabled()) return null;
  try {
    return await request("v1/agents/heartbeat", {
      method: "POST",
      body: {
        agentId: agentId(),
        version: AGENT_VERSION,
        label: sanitize(config.hivemind.label, 40),
        reason,
        at: new Date().toISOString(),
        capabilities: {
          telegram: !!config.telegram.botToken,
          dryRun: config.dryRun,
          rangePreset: config.range.preset,
          watcher: config.schedule.watcherEnabled,
        },
      },
    });
  } catch (err) {
    log("hivemind_warn", `Heartbeat failed: ${err.message}`);
    return null;
  }
}

/** Register, pull, and start the background sync. No-op when disabled. */
export async function start() {
  if (!isEnabled()) {
    log("hivemind", "Disabled — set hivemindUrl in user-config.json to join a swarm");
    return { enabled: false };
  }

  agentId();
  const tasks = [heartbeat("startup")];
  if (config.hivemind.pullMode === "auto") tasks.push(pullLessons(), pullPresets());
  await Promise.allSettled(tasks);

  heartbeatTimer ??= setInterval(() => {
    const work = [heartbeat()];
    if (config.hivemind.pullMode === "auto") work.push(pullLessons());
    Promise.allSettled(work).catch(() => null);
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  log("hivemind", `Connected to ${config.hivemind.url} as ${agentId()}${config.hivemind.share ? "" : " (pull only)"}`);
  return { enabled: true, agentId: agentId(), url: config.hivemind.url, pullMode: config.hivemind.pullMode };
}

export function stop() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

export function status() {
  const state = cache.read();
  return {
    enabled: isEnabled(),
    url: config.hivemind.url ?? null,
    agentId: config.hivemind.agentId ?? null,
    pullMode: config.hivemind.pullMode,
    sharing: config.hivemind.share,
    cachedLessons: state.lessons.length,
    cachedPresets: state.presets.length,
    pulledAt: state.pulledAt,
  };
}
