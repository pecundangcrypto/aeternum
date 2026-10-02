/**
 * Decision journal.
 *
 * Every open, close, skip and no-op is written here with its reasoning, the
 * numbers behind it, and what was rejected instead. Recent entries are fed back
 * into the prompt so the agent can answer "why did you close that?" from a
 * record instead of reconstructing a plausible story after the fact.
 */

import { createStore, trimList } from "./json-store.js";
import { dataPath } from "../paths.js";

const store = createStore(dataPath("journal.json"), { entries: [] });
const MAX_ENTRIES = 300;

function clean(value, maxLength = 400) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
  return text || null;
}

/**
 * @param {object} entry
 * @param {"open"|"close"|"harvest"|"skip"|"no_deploy"|"config"|"error"} entry.kind
 * @param {string} entry.actor  which cycle or surface produced it
 */
export function record(entry) {
  const row = {
    at: new Date().toISOString(),
    kind: entry.kind,
    actor: entry.actor ?? "agent",
    pool: clean(entry.pool, 64),
    pair: clean(entry.pair, 64),
    positionMint: clean(entry.positionMint, 64),
    summary: clean(entry.summary, 300),
    reason: clean(entry.reason, 600),
    risks: Array.isArray(entry.risks) ? entry.risks.map((risk) => clean(risk, 160)).filter(Boolean).slice(0, 5) : [],
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((alt) => clean(alt, 160)).filter(Boolean).slice(0, 5) : [],
    metrics: entry.metrics && typeof entry.metrics === "object" ? entry.metrics : null,
  };
  store.update((state) => {
    state.entries = trimList([...state.entries, row], MAX_ENTRIES);
  });
  return row;
}

export function recent(limit = 12, kind = null) {
  const entries = store.read().entries.filter((row) => !kind || row.kind === kind);
  return entries.slice(Math.max(0, entries.length - limit)).reverse();
}

/** One-line-per-decision digest for the system prompt. */
export function journalDigest(limit = 6) {
  const entries = recent(limit);
  if (!entries.length) return null;
  return entries
    .map((row) => {
      const when = row.at.slice(5, 16).replace("T", " ");
      const what = row.pair || row.pool?.slice(0, 8) || "-";
      return `- ${when} ${row.kind.toUpperCase()} ${what}: ${row.summary ?? row.reason ?? ""}`.trim();
    })
    .join("\n");
}
