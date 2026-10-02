#!/usr/bin/env node
/**
 * Reference Hivemind server.
 *
 * A complete, dependency-free implementation of the protocol the agent's
 * hivemind client speaks. Run it on any box a group of operators can reach and
 * they share conclusions without sharing wallets.
 *
 * It exists so that "hivemind" is a thing you can actually run rather than a
 * pointer at someone else's endpoint. The whole point of the design is that no
 * single server is privileged: host your own, or point several agents at one.
 *
 *   node hivemind-server/server.js
 *   PORT=8787 HIVEMIND_KEYS=key-one,key-two node hivemind-server/server.js
 *
 * Storage is a single JSON file. That is genuinely adequate: the write volume is
 * a handful of records per agent per day.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.HIVEMIND_DB || path.join(HERE, "hivemind-db.json");
const PORT = Number(process.env.PORT || 8787);
// Loopback by default. A hivemind holds other operators' lessons, so it should
// only be reachable off-box once someone has deliberately set HOST and keys.
const HOST = process.env.HOST || "127.0.0.1";

// Comma-separated allowlist. Empty means open — fine on a private network, not
// on a public IP.
const KEYS = (process.env.HIVEMIND_KEYS || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_LESSONS = 2_000;
const MAX_OUTCOMES = 20_000;

function load() {
  if (!fs.existsSync(DB_PATH)) return { agents: {}, lessons: [], outcomes: [], presets: [] };
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { agents: {}, lessons: [], outcomes: [], presets: [] };
  }
}

let db = load();
let dirty = false;

function persist() {
  if (!dirty) return;
  const temp = `${DB_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_PATH);
  dirty = false;
}
setInterval(persist, 5_000).unref();

function clean(value, maxLength = 400) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").replace(/[<>`]/g, "").trim().slice(0, maxLength);
  return text || null;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : null;
}

/** Normalise a rule for dedup: lessons that say the same thing should merge. */
function fingerprint(rule) {
  return String(rule).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Trust is agreement.
 *
 * A single agent asserting something is one data point. Five independent agents
 * deriving the same lesson from their own closed positions is a signal. The
 * server tracks how many distinct agents reported each fingerprint and serves
 * lessons in that order — it never tries to judge whether a lesson is *true*.
 */
function recordLesson(agentId, lesson) {
  const rule = clean(lesson?.rule, 400);
  if (!rule) return { error: "lesson.rule is required" };

  const key = fingerprint(rule);
  const existing = db.lessons.find((entry) => entry.fingerprint === key);

  if (existing) {
    if (!existing.reporters.includes(agentId)) {
      existing.reporters.push(agentId);
      existing.agreement = existing.reporters.length;
    }
    existing.lastSeenAt = new Date().toISOString();
    existing.observations += 1;
    dirty = true;
    return { merged: true, id: existing.id, agreement: existing.agreement };
  }

  const entry = {
    id: `hl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    fingerprint: key,
    rule,
    role: lesson.role ? String(lesson.role).toUpperCase().slice(0, 16) : null,
    tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => clean(tag, 32)).filter(Boolean).slice(0, 6) : [],
    source: clean(lesson.source, 32),
    pool: clean(lesson.pool, 64),
    metrics: lesson.metrics
      ? {
          pnlPct: num(lesson.metrics.pnlPct),
          rangeEfficiency: num(lesson.metrics.rangeEfficiency),
          minutesHeld: num(lesson.metrics.minutesHeld),
          closeReason: clean(lesson.metrics.closeReason, 120),
        }
      : null,
    reporters: [agentId],
    agreement: 1,
    observations: 1,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };

  db.lessons.push(entry);
  if (db.lessons.length > MAX_LESSONS) {
    // Evict the least-agreed, oldest lessons first.
    db.lessons.sort((left, right) => right.agreement - left.agreement || right.lastSeenAt.localeCompare(left.lastSeenAt));
    db.lessons = db.lessons.slice(0, MAX_LESSONS);
  }
  dirty = true;
  return { created: true, id: entry.id, agreement: 1 };
}

function recordOutcome(agentId, outcome) {
  const pool = clean(outcome?.pool, 64);
  if (!pool) return { error: "outcome.pool is required" };

  db.outcomes.push({
    agentId,
    pool,
    pair: clean(outcome.pair, 40),
    baseMint: clean(outcome.baseMint, 64),
    rangePreset: clean(outcome.rangePreset, 32),
    widthPct: num(outcome.widthPct),
    skew: num(outcome.skew),
    pnlPct: num(outcome.pnlPct),
    feeAprRealised: num(outcome.feeAprRealised),
    minutesHeld: num(outcome.minutesHeld),
    rangeEfficiency: num(outcome.rangeEfficiency),
    closeReason: clean(outcome.closeReason, 160),
    entrySnapshot: outcome.entrySnapshot ?? null,
    at: new Date().toISOString(),
  });
  if (db.outcomes.length > MAX_OUTCOMES) db.outcomes = db.outcomes.slice(-MAX_OUTCOMES);
  dirty = true;
  return { recorded: true, total: db.outcomes.length };
}

/**
 * Aggregate the outcome pool into presets other agents can adopt.
 *
 * Grouped by range preset, reported only where there is enough signal to be
 * worth anything. The server states the sample size and lets each agent decide.
 */
function buildPresets() {
  const groups = new Map();
  for (const outcome of db.outcomes) {
    const key = outcome.rangePreset;
    if (!key || outcome.pnlPct == null) continue;
    const bucket = groups.get(key) ?? { preset: key, samples: 0, wins: 0, pnl: 0, widths: [], efficiency: [] };
    bucket.samples += 1;
    bucket.wins += outcome.pnlPct > 0 ? 1 : 0;
    bucket.pnl += outcome.pnlPct;
    if (outcome.widthPct != null) bucket.widths.push(outcome.widthPct);
    if (outcome.rangeEfficiency != null) bucket.efficiency.push(outcome.rangeEfficiency);
    groups.set(key, bucket);
  }

  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return Number(sorted[Math.floor(sorted.length / 2)].toFixed(2));
  };

  return [...groups.values()]
    .filter((bucket) => bucket.samples >= 8)
    .map((bucket) => ({
      preset: bucket.preset,
      samples: bucket.samples,
      winRate: Number(((bucket.wins / bucket.samples) * 100).toFixed(1)),
      avgPnlPct: Number((bucket.pnl / bucket.samples).toFixed(2)),
      medianWidthPct: median(bucket.widths),
      medianRangeEfficiency: median(bucket.efficiency),
    }))
    .sort((left, right) => right.avgPnlPct - left.avgPnlPct);
}

function authorized(req) {
  if (!KEYS.length) return true;
  return KEYS.includes(req.headers["x-api-key"]);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname.replace(/\/$/, "")}`;

  if (route === "GET /v1/health") {
    return reply(res, 200, {
      ok: true,
      agents: Object.keys(db.agents).length,
      lessons: db.lessons.length,
      outcomes: db.outcomes.length,
    });
  }

  if (!authorized(req)) return reply(res, 401, { error: "invalid api key" });

  try {
    switch (route) {
      case "POST /v1/agents/heartbeat": {
        const body = await readBody(req);
        const agentId = clean(body.agentId, 64);
        if (!agentId) return reply(res, 400, { error: "agentId is required" });
        db.agents[agentId] = {
          agentId,
          version: clean(body.version, 20),
          label: clean(body.label, 40),
          capabilities: body.capabilities ?? null,
          lastSeenAt: new Date().toISOString(),
          firstSeenAt: db.agents[agentId]?.firstSeenAt ?? new Date().toISOString(),
        };
        dirty = true;
        return reply(res, 200, { ok: true, peers: Object.keys(db.agents).length });
      }

      case "GET /v1/lessons": {
        const limit = Math.min(100, Number(url.searchParams.get("limit")) || 40);
        const requester = url.searchParams.get("agentId");
        const role = url.searchParams.get("role");
        const lessons = db.lessons
          // Do not echo an agent's own lessons back at it as swarm consensus
          // unless somebody else independently agreed.
          .filter((lesson) => lesson.agreement > 1 || !lesson.reporters.includes(requester))
          .filter((lesson) => !role || !lesson.role || lesson.role === role.toUpperCase())
          .sort((left, right) => right.agreement - left.agreement || right.lastSeenAt.localeCompare(left.lastSeenAt))
          .slice(0, limit)
          .map((lesson) => ({
            id: lesson.id,
            rule: lesson.rule,
            role: lesson.role,
            tags: lesson.tags,
            agreement: lesson.agreement,
            at: lesson.lastSeenAt,
          }));
        return reply(res, 200, { lessons });
      }

      case "POST /v1/lessons": {
        const body = await readBody(req);
        const agentId = clean(body.agentId, 64);
        if (!agentId) return reply(res, 400, { error: "agentId is required" });
        const result = recordLesson(agentId, body.lesson ?? {});
        return reply(res, result.error ? 400 : 200, result);
      }

      case "POST /v1/performance": {
        const body = await readBody(req);
        const agentId = clean(body.agentId, 64);
        if (!agentId) return reply(res, 400, { error: "agentId is required" });
        const result = recordOutcome(agentId, body.outcome ?? {});
        return reply(res, result.error ? 400 : 200, result);
      }

      case "GET /v1/presets":
        return reply(res, 200, { presets: buildPresets() });

      case "GET /v1/stats": {
        const pools = new Map();
        for (const outcome of db.outcomes) {
          const bucket = pools.get(outcome.pool) ?? { pool: outcome.pool, pair: outcome.pair, samples: 0, wins: 0, pnl: 0 };
          bucket.samples += 1;
          bucket.wins += (outcome.pnlPct ?? 0) > 0 ? 1 : 0;
          bucket.pnl += outcome.pnlPct ?? 0;
          pools.set(outcome.pool, bucket);
        }
        return reply(res, 200, {
          agents: Object.values(db.agents).length,
          lessons: db.lessons.length,
          outcomes: db.outcomes.length,
          topPools: [...pools.values()]
            .filter((bucket) => bucket.samples >= 3)
            .map((bucket) => ({
              ...bucket,
              winRate: Number(((bucket.wins / bucket.samples) * 100).toFixed(1)),
              avgPnlPct: Number((bucket.pnl / bucket.samples).toFixed(2)),
            }))
            .sort((left, right) => right.avgPnlPct - left.avgPnlPct)
            .slice(0, 20),
        });
      }

      default:
        return reply(res, 404, { error: `no route for ${route}` });
    }
  } catch (err) {
    return reply(res, 400, { error: err.message });
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    persist();
    server.close(() => process.exit(0));
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Hivemind server on ${HOST}:${PORT}`);
  console.log(`  storage  ${DB_PATH}`);
  console.log(`  auth     ${KEYS.length ? `${KEYS.length} api key(s)` : HOST === "127.0.0.1" ? "none (loopback only)" : "OPEN — set HIVEMIND_KEYS, this is reachable off-box"}`);
  console.log(`  peers    ${Object.keys(db.agents).length} known, ${db.lessons.length} lessons, ${db.outcomes.length} outcomes`);
});
