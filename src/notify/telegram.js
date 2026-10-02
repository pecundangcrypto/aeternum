/**
 * Telegram control surface.
 *
 * The primary interface when the agent runs headless on a VPS: read positions,
 * close one, flip a threshold, or just talk to it. Everything the REPL can do is
 * reachable from a phone.
 *
 * Safety model:
 *   - A chat id must be configured explicitly. The bot never adopts whoever
 *     messages it first — that would hand control to anyone who finds the bot.
 *   - In groups, only `allowedUserIds` may issue commands.
 *   - Positions are addressed by their index in `/positions`, never by raw mint,
 *     so a mistyped address cannot touch the wrong position.
 *
 * Actions are injected by the runtime rather than imported, which keeps this
 * module free of any dependency on the cycles that notify through it.
 */

import { config } from "../config.js";
import { log } from "../logger.js";

const API_BASE = "https://api.telegram.org";
const POLL_TIMEOUT_S = 30;

let offset = 0;
let polling = false;
let actions = {};
let positionIndex = [];

/** Wire up the behaviours the runtime owns. Called once at startup. */
export function registerActions(next) {
  actions = { ...actions, ...next };
}

export function isEnabled() {
  return !!(config.telegram.botToken && config.telegram.chatId);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function call(method, body = {}) {
  if (!config.telegram.botToken) return null;
  try {
    const response = await fetch(`${API_BASE}/bot${config.telegram.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1_000),
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) {
      // 409 means a second poller is fighting this one — worth saying out loud.
      const description = payload?.description ?? `HTTP ${response.status}`;
      if (response.status === 401) {
        log("telegram_error", "401 Unauthorized — TELEGRAM_BOT_TOKEN is wrong or revoked");
      } else if (response.status === 409) {
        log("telegram_error", "409 Conflict — another process is polling this bot token");
      } else if (method !== "getUpdates") {
        log("telegram_warn", `${method} failed: ${description}`);
      }
      return null;
    }
    return payload.result;
  } catch (err) {
    if (err.name !== "TimeoutError" && method !== "getUpdates") {
      log("telegram_warn", `${method} error: ${err.message}`);
    }
    return null;
  }
}

// ─── Outbound ───────────────────────────────────────────────────────────────

export async function send(text, { buttons = null, keyboard = null, chatId = null } = {}) {
  if (!isEnabled()) return null;
  const replyMarkup = buttons ? { inline_keyboard: buttons } : keyboard;
  return call("sendMessage", {
    chat_id: chatId ?? config.telegram.chatId,
    text: String(text).slice(0, 4_000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// ─── Tap-to-run keyboard ────────────────────────────────────────────────────

/**
 * A persistent keyboard in place of the text input, so the common commands are
 * one tap rather than typed. Each button simply sends its label, which is mapped
 * back to the command below — so a tap and a typed command take the same path.
 */
const KEYBOARD_ROWS = [
  [["📊 Status", "/status"], ["📈 Positions", "/positions"]],
  [["🔎 Screen", "/screen"], ["⚙️ Manage", "/manage"]],
  [["🧭 Candidates", "/candidates"], ["📉 Performance", "/performance"]],
  [["🛠 Config", "/config"], ["🧠 Lessons", "/lessons"]],
  [["⏸ Pause", "/pause"], ["▶️ Resume", "/resume"], ["❓ Help", "/help"]],
];

const LABEL_TO_COMMAND = new Map(KEYBOARD_ROWS.flat());

export const MAIN_KEYBOARD = {
  keyboard: KEYBOARD_ROWS.map((row) => row.map(([label]) => ({ text: label }))),
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Tap a button, or ask anything",
};

async function edit(messageId, text, { buttons = null } = {}) {
  if (!isEnabled()) return null;
  return call("editMessageText", {
    chat_id: config.telegram.chatId,
    message_id: messageId,
    text: String(text).slice(0, 4_000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

function fmtPct(value, { sign = true } = {}) {
  if (!Number.isFinite(value)) return "n/a";
  const prefix = sign && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function fmtMoney(value) {
  if (!Number.isFinite(value)) return "n/a";
  const prefix = value < 0 ? "-$" : "$";
  return `${prefix}${Math.abs(value).toFixed(2)}`;
}

function fmtDuration(minutes) {
  if (!Number.isFinite(minutes)) return "n/a";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}

/** Position of the price inside the range, drawn as a bar. */
function rangeBar(progress, { width = 12 } = {}) {
  if (!Number.isFinite(progress)) return "─".repeat(width);
  if (progress < 0) return `◀${"─".repeat(width - 1)}`;
  if (progress > 1) return `${"─".repeat(width - 1)}▶`;
  const slot = Math.min(width - 1, Math.max(0, Math.round(progress * (width - 1))));
  return `${"─".repeat(slot)}●${"─".repeat(width - 1 - slot)}`;
}

// ─── Notifications ──────────────────────────────────────────────────────────

export async function positionOpened(result) {
  if (!isEnabled()) return;
  const lines = [
    `🟢 <b>Opened ${escapeHtml(result.pair ?? "position")}</b>${result.dryRun ? " <i>(dry run)</i>" : ""}`,
    `Size: ${result.deploySol} SOL (${fmtMoney(result.entryValueUsd)})`,
    `Range: ${result.range.downsidePct}% / +${result.range.upsidePct}% — width ${result.range.widthPct}%, skew ${result.range.skew}`,
    `Split: ${(result.depositSplit.ratioA * 100).toFixed(0)}% / ${(result.depositSplit.ratioB * 100).toFixed(0)}%`,
  ];
  if (result.tx) lines.push(`<a href="https://solscan.io/tx/${result.tx}">transaction</a>`);
  await send(lines.join("\n"));
}

export async function positionClosed({ pair, reason, record, trigger }) {
  if (!isEnabled()) return;
  const pnlPct = record?.pnlPct;
  const icon = pnlPct == null ? "⚪" : pnlPct > 0 ? "🔵" : "🔴";
  const lines = [
    `${icon} <b>Closed ${escapeHtml(pair)}</b>${trigger ? ` — ${escapeHtml(trigger.replace(/_/g, " "))}` : ""}`,
  ];
  if (record) {
    lines.push(
      `PnL: <b>${fmtPct(pnlPct)}</b> (${fmtMoney(record.pnlUsd)}) | fees ${fmtMoney(record.feesUsd)}`,
      `Held ${fmtDuration(record.minutesHeld)} | peak ${fmtPct(record.peakPnlPct)}${record.rangeEfficiency != null ? ` | in range ${(record.rangeEfficiency * 100).toFixed(0)}%` : ""}`,
    );
  }
  lines.push(`<i>${escapeHtml(reason)}</i>`);
  if (record?.closeTx) lines.push(`<a href="https://solscan.io/tx/${record.closeTx}">transaction</a>`);
  await send(lines.join("\n"));
}

export async function screenReport(summary) {
  if (!isEnabled()) return;
  // An outage is announced by the runtime's health alert, once. Repeating the
  // provider's error text every cycle as if it were a screening result is the
  // noise that made the real failure invisible last time.
  if (summary.failed) return;
  const header = summary.skipped
    ? "⏭ <b>Screening skipped</b>"
    : summary.deployed
      ? "🔎 <b>Screening — deployed</b>"
      : "🔎 <b>Screening — no deploy</b>";
  const body = summary.skipped ? summary.reason : summary.report;
  await send(`${header}\n${escapeHtml(body ?? "")}`.slice(0, 3_500));
}

export async function manageReport(summary) {
  if (!isEnabled()) return;
  // Nothing happened and nothing is open — no reason to buzz a phone.
  if (!summary.closed && !summary.harvested && !summary.held) return;

  const lines = [
    `⚙️ <b>Management</b> — ${summary.closed} closed, ${summary.harvested} harvested, ${summary.held} held`,
  ];
  if (summary.report) lines.push(escapeHtml(summary.report));
  await send(lines.join("\n").slice(0, 3_500));
}

export async function alert(text) {
  if (!isEnabled()) return;
  await send(`⚠️ ${escapeHtml(text)}`);
}

// ─── Inbound ────────────────────────────────────────────────────────────────

function isAuthorized(message) {
  const chatId = String(message?.chat?.id ?? "");
  if (!chatId || chatId !== String(config.telegram.chatId)) return false;

  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  if (!isGroup) return true;

  // In a group, the chat id alone is not identity — anyone in it could type.
  const userId = String(message.from?.id ?? "");
  if (!config.telegram.allowedUserIds.length) {
    log("telegram_warn", "Group command ignored — set telegramAllowedUserIds to allow control from a group");
    return false;
  }
  return config.telegram.allowedUserIds.includes(userId);
}

const HELP = `<b>Aeternum</b> — Orca Whirlpools liquidity agent

Use the buttons below, or type any command.

<b>Positions</b>
/positions — open positions with live PnL
/close &lt;n&gt; — close position n
/note &lt;n&gt; &lt;text&gt; — annotate position n
/harvest &lt;n&gt; — collect fees on position n

<b>Cycles</b>
/screen — run a screening cycle now
/manage — run a management cycle now
/candidates — show current candidates without deploying

<b>State</b>
/status — wallet, positions, watcher
/performance — closed-position statistics
/config — settings, with toggles
/lessons — what the agent has learned
/hivemind — swarm sync status

<b>Control</b>
/pause — stop exit rules from firing
/resume — resume exit rules
/evolve — retune thresholds from performance

Anything else is treated as a message to the agent.`;

function configButtons() {
  const m = config.management;
  const toggle = (key, label, value) => ({
    text: `${value ? "✅" : "❌"} ${label}`,
    callback_data: `toggle:${key}`,
  });
  const step = (key, label, delta) => [
    { text: `− ${label}`, callback_data: `dec:${key}:${delta}` },
    { text: `${label} ${config.management[key] ?? config.screening[key] ?? ""}`, callback_data: "noop" },
    { text: `+ ${label}`, callback_data: `inc:${key}:${delta}` },
  ];

  return [
    [toggle("trailingTakeProfit", "Trailing TP", m.trailingTakeProfit), toggle("autoSwapToSol", "Swap back to SOL on exit", m.autoSwapToSol)],
    [toggle("watcherEnabled", "Fast watcher", config.schedule.watcherEnabled), toggle("solMode", "SOL mode", m.solMode)],
    step("trailingTriggerPct", "trigger", 0.5),
    step("trailingDropPct", "drop", 0.25),
    step("takeProfitPct", "TP", 1),
    step("stopLossPct", "SL", 1),
    [{ text: "↻ refresh", callback_data: "refresh:config" }],
  ];
}

async function configMessage() {
  const s = config.screening;
  const m = config.management;
  const r = config.range;
  return [
    `<b>Configuration</b>${config.dryRun ? " — <i>DRY RUN</i>" : ""}`,
    "",
    `<b>Risk</b>: max ${config.risk.maxPositions} positions, ${config.risk.minDeploySol}–${config.risk.maxDeploySol} SOL each, ${(m.positionSizePct * 100).toFixed(0)}% of deployable`,
    `<b>Range</b>: ${r.preset}${r.adaptiveWidth ? ` (adaptive ×${r.adaptiveWidthFactor})` : ""}, ${r.minWidthPct}–${r.maxWidthPct}% width`,
    `<b>Exits</b>: TP ${m.takeProfitPct}% | SL ${m.stopLossPct}% | trailing ${m.trailingTakeProfit ? `${m.trailingTriggerPct}% → −${m.trailingDropPct}%` : "off"}`,
    `<b>Timers</b>: OOR ${m.outOfRangeWaitMinutes}m | max hold ${m.maxHoldHours}h | yield floor ${(m.minFeeAprToHold * 100).toFixed(0)}% after ${m.yieldGraceMinutes}m`,
    `<b>Screening</b>: score ≥${s.minYieldScore}, fee APR ≥${(s.minFeeApr * 100).toFixed(0)}%, TVL $${Math.round(s.minTvlUsd / 1000)}k–$${Math.round(s.maxTvlUsd / 1000)}k, turnover ≥${s.minVolumeTvlRatio}x`,
    `<b>Schedule</b>: screen ${config.schedule.screenIntervalMin}m | manage ${config.schedule.manageIntervalMin}m | watcher ${config.schedule.watcherIntervalSec}s`,
  ].join("\n");
}

async function renderPositions() {
  const result = await actions.positions?.();
  positionIndex = (result?.positions ?? []).map((position) => position.positionMint);

  if (!result?.positions?.length) {
    return `No open positions. ${config.risk.maxPositions} slot${config.risk.maxPositions === 1 ? "" : "s"} free.`;
  }

  const lines = [`<b>${result.positions.length}/${result.maxPositions} positions open</b>`];
  for (const position of result.positions) {
    const pnl = config.management.solMode
      ? `${position.pnlSol != null ? `${position.pnlSol > 0 ? "+" : ""}${position.pnlSol.toFixed(4)} SOL` : "n/a"}`
      : fmtMoney(position.pnlUsd);
    lines.push(
      "",
      `<b>${position.index}. ${escapeHtml(position.pair ?? position.positionMint.slice(0, 8))}</b>${position.trailingActive ? " 🔒" : ""}`,
      `<code>${rangeBar(position.rangeProgress)}</code> ${position.inRange ? "in range" : escapeHtml(String(position.status).replace("price", "").toLowerCase())}`,
      `PnL <b>${fmtPct(position.pnlPct)}</b> ${pnl} | peak ${fmtPct(position.peakPnlPct)}`,
      `Fees ${fmtMoney(position.feesUsd)} | fee APR ${position.feeApr != null ? `${(position.feeApr * 100).toFixed(0)}%` : "n/a"} | held ${fmtDuration(position.minutesHeld)}`,
    );
    if (position.note) lines.push(`<i>${escapeHtml(position.note)}</i>`);
  }
  lines.push("", "<i>🔒 = trailing take-profit armed. Tap a button below to close.</i>");
  return lines.join("\n");
}

function resolveIndex(raw) {
  const index = Number.parseInt(raw, 10);
  if (!Number.isFinite(index) || index < 1) return { error: "Give a position number, e.g. /close 1" };
  const mint = positionIndex[index - 1];
  if (!mint) return { error: "Unknown position number. Run /positions first to refresh the list." };
  return { mint, index };
}

async function handleCommand(message, text) {
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const argument = rest.join(" ");

  switch (command) {
    case "/start":
    case "/help":
    case "/menu":
      return send(HELP, { keyboard: MAIN_KEYBOARD });

    case "/positions": {
      const text = await renderPositions();
      // One close button per position. Each asks for confirmation first: with
      // real capital in play, a mis-tap must not be enough to exit.
      const buttons = positionIndex.map((mint, i) => [
        { text: `✖ Close ${i + 1}`, callback_data: `ask:close:${i + 1}` },
      ]);
      return send(text, buttons.length ? { buttons } : {});
    }

    case "/status": {
      const status = await actions.status?.();
      if (!status) return send("Status is unavailable.");
      const lines = [
        `<b>Aeternum</b>${config.dryRun ? " — <i>DRY RUN</i>" : ""}`,
        `Wallet: ${status.balances.sol.toFixed(4)} SOL (${status.balances.deployableSol.toFixed(4)} deployable)`,
        `Positions: ${status.ledger.openCount}/${status.ledger.maxPositions}${status.ledger.winRate != null ? ` | win rate ${status.ledger.winRate}% over ${status.ledger.closedCount} closes` : ""}`,
        `Watcher: ${status.watcher.running ? `every ${status.watcher.intervalSec}s` : "off"}${status.watcher.paused ? " <b>(paused)</b>" : ""} | ${status.watcher.ticks} ticks`,
        `Next: screen in ${status.next.screenMin}m, manage in ${status.next.manageMin}m`,
      ];
      if (status.hivemind?.enabled) lines.push(`Hivemind: ${status.hivemind.cachedLessons} shared lessons`);
      return send(lines.join("\n"));
    }

    case "/close": {
      const resolved = resolveIndex(argument.split(/\s+/)[0]);
      if (resolved.error) return send(resolved.error);
      await send(`Closing position ${resolved.index}…`);
      try {
        const result = await actions.close?.({ positionMint: resolved.mint, reason: "Closed manually from Telegram" });
        return send(
          result?.record
            ? `Closed at <b>${fmtPct(result.record.pnlPct)}</b> (${fmtMoney(result.record.pnlUsd)}) after ${fmtDuration(result.record.minutesHeld)}.`
            : "Close submitted.",
        );
      } catch (err) {
        return send(`Close failed: ${escapeHtml(err.message)}`);
      }
    }

    case "/harvest": {
      const resolved = resolveIndex(argument.split(/\s+/)[0]);
      if (resolved.error) return send(resolved.error);
      try {
        const result = await actions.harvest?.({ positionMint: resolved.mint });
        return send(`Harvested ${result?.feesUsd != null ? fmtMoney(result.feesUsd) : "fees"} on position ${resolved.index}.`);
      } catch (err) {
        return send(`Harvest failed: ${escapeHtml(err.message)}`);
      }
    }

    case "/note": {
      const [indexPart, ...noteParts] = argument.split(/\s+/);
      const resolved = resolveIndex(indexPart);
      if (resolved.error) return send(resolved.error);
      const note = noteParts.join(" ");
      if (!note) return send("Usage: /note &lt;n&gt; &lt;text&gt;");
      await actions.note?.({ positionMint: resolved.mint, note });
      return send(`Noted on position ${resolved.index}.`);
    }

    case "/screen":
      await send("Running a screening cycle…");
      try {
        const summary = await actions.screen?.({ silent: true });
        return send(
          summary?.skipped
            ? `Skipped: ${escapeHtml(summary.reason)}`
            : `${summary?.deployed ? "Deployed." : "No deploy."}\n${escapeHtml(summary?.report ?? "")}`.slice(0, 3_500),
        );
      } catch (err) {
        return send(`Screening failed: ${escapeHtml(err.message)}`);
      }

    case "/manage":
      await send("Running a management cycle…");
      try {
        const summary = await actions.manage?.({ silent: true });
        return send(
          `${summary.closed} closed, ${summary.harvested} harvested, ${summary.held} held.\n${escapeHtml(summary.report ?? "")}`.slice(0, 3_500),
        );
      } catch (err) {
        return send(`Management failed: ${escapeHtml(err.message)}`);
      }

    case "/candidates": {
      await send("Screening…");
      const result = await actions.candidates?.();
      if (!result?.candidates?.length) {
        return send(`No candidates passed the filters. Scanned ${result?.scanned ?? 0} pools; ${result?.rejected?.length ?? 0} rejected.`);
      }
      const lines = [`<b>Top candidates</b> (${result.scanned} pools scanned)`];
      for (const pool of result.candidates.slice(0, 6)) {
        lines.push(
          "",
          `<b>${escapeHtml(pool.pair)}</b> · spacing ${pool.tickSpacing} · score <b>${pool.yieldScore}</b>`,
          `fee APR ${(pool.feeApr * 100).toFixed(0)}% | turnover ${pool.volumeTvlRatio}x | TVL ${fmtMoney(pool.tvlUsd)}`,
          `24h move ${pool.priceDelta24h != null ? `${(pool.priceDelta24h * 100).toFixed(1)}%` : "n/a"} | holders ${pool.token?.holders ?? "?"} | top10 ${pool.token?.top10Pct != null ? `${pool.token.top10Pct.toFixed(0)}%` : "?"}`,
          `<code>${pool.address}</code>`,
        );
      }
      return send(lines.join("\n").slice(0, 3_800));
    }

    case "/config":
      return send(await configMessage(), { buttons: configButtons() });

    case "/performance": {
      const stats = await actions.performance?.();
      if (!stats || !stats.sampleSize) return send("No closed positions yet.");
      return send(
        [
          `<b>Performance</b> over ${stats.sampleSize} closes`,
          `Win rate <b>${stats.winRate}%</b> | avg ${fmtPct(stats.avgPnlPct)} | median ${fmtPct(stats.medianPnlPct)}`,
          `Best ${fmtPct(stats.bestPnlPct)} | worst ${fmtPct(stats.worstPnlPct)}`,
          `Total PnL ${fmtMoney(stats.totalPnlUsd)} | fees ${fmtMoney(stats.totalFeesUsd)}`,
          `Avg hold ${fmtDuration(stats.avgMinutesHeld)}${stats.avgRangeEfficiency != null ? ` | avg time in range ${(stats.avgRangeEfficiency * 100).toFixed(0)}%` : ""}`,
          "",
          "<b>Exits</b>",
          ...stats.byCloseReason.slice(0, 5).map((row) => `· ${escapeHtml(row.key)} ×${row.count} — ${row.winRate}% win, avg ${fmtPct(row.avgPnlPct)}`),
        ].join("\n"),
      );
    }

    case "/lessons": {
      const result = await actions.lessons?.();
      if (!result?.lessons?.length) return send("No lessons recorded yet.");
      return send(
        [`<b>Lessons</b>`, ...result.lessons.slice(0, 12).map((lesson) => `${lesson.pinned ? "📌" : "·"} ${escapeHtml(lesson.rule)}`)].join("\n").slice(0, 3_800),
      );
    }

    case "/hivemind": {
      const status = await actions.hivemind?.();
      if (!status?.enabled) {
        return send("Hivemind is off. Set <code>hivemindUrl</code> in user-config.json to join or host a swarm.");
      }
      return send(
        [
          `<b>Hivemind</b> — ${escapeHtml(status.url)}`,
          `Agent id: <code>${status.agentId}</code>`,
          `Mode: ${status.pullMode} | sharing ${status.sharing ? "on" : "off"}`,
          `Cached: ${status.cachedLessons} lessons, ${status.cachedPresets} presets`,
          status.pulledAt ? `Last pull: ${status.pulledAt.slice(0, 19).replace("T", " ")}` : "Never pulled",
        ].join("\n"),
      );
    }

    case "/pause":
      await actions.pause?.();
      return send("Exit rules paused. Positions are <b>not</b> being protected until /resume.");

    case "/resume":
      await actions.resume?.();
      return send("Exit rules resumed.");

    case "/evolve": {
      const result = await actions.evolve?.();
      if (!result?.evolved) return send(`No change: ${escapeHtml(result?.reason ?? "unknown")}`);
      return send(
        [`<b>Thresholds retuned</b>`, ...result.changes.map((change) => `· ${change.key}: ${change.from} → ${change.to}\n  <i>${escapeHtml(change.why)}</i>`)].join("\n"),
      );
    }

    default:
      return null; // fall through to chat
  }
}

async function handleCallback(query) {
  const data = String(query.data ?? "");
  const answer = (text) => call("answerCallbackQuery", { callback_query_id: query.id, text: text?.slice(0, 200) ?? "" });

  if (data === "noop") return answer();

  if (data === "cancel") {
    await edit(query.message.message_id, "Cancelled — nothing was closed.");
    return answer("Cancelled");
  }

  try {
    if (data.startsWith("ask:close:")) {
      const resolved = resolveIndex(data.slice("ask:close:".length));
      if (resolved.error) return answer(resolved.error);
      const mode = resolved.mint.startsWith("dryrun_") ? "paper position" : config.dryRun ? "real position (agent is in dry run)" : "REAL position — this signs a transaction";
      // The confirmation carries the exact mint, so a list that changed since it
      // was rendered cannot redirect the close to a different position.
      await send(`Close position ${resolved.index}? <i>${escapeHtml(mode)}</i>`, {
        buttons: [[
          { text: "✅ Yes, close it", callback_data: `do:close:${resolved.mint}` },
          { text: "Cancel", callback_data: "cancel" },
        ]],
      });
      return answer();
    }

    if (data.startsWith("do:close:")) {
      const positionMint = data.slice("do:close:".length);
      await edit(query.message.message_id, "Closing…");
      answer("Closing");
      try {
        const result = await actions.close?.({ positionMint, reason: "Closed from Telegram" });
        await edit(
          query.message.message_id,
          result?.record
            ? `Closed at <b>${fmtPct(result.record.pnlPct)}</b> (${fmtMoney(result.record.pnlUsd)}) after ${fmtDuration(result.record.minutesHeld)}.`
            : "Close submitted.",
        );
      } catch (err) {
        await edit(query.message.message_id, `Close refused: ${escapeHtml(err.message)}`);
      }
      return undefined;
    }

    if (data === "refresh:config") {
      await edit(query.message.message_id, await configMessage(), { buttons: configButtons() });
      return answer("Refreshed");
    }

    const [operation, key, deltaRaw] = data.split(":");

    if (operation === "toggle") {
      const current =
        key === "watcherEnabled" ? config.schedule.watcherEnabled : config.management[key] ?? config.screening[key];
      const change = await actions.setConfig?.({ key, value: !current, reason: "Toggled from Telegram" });
      await edit(query.message.message_id, await configMessage(), { buttons: configButtons() });
      return answer(`${key} → ${change?.value}`);
    }

    if (operation === "inc" || operation === "dec") {
      const delta = Number(deltaRaw) * (operation === "dec" ? -1 : 1);
      const current = Number(config.management[key] ?? config.screening[key] ?? 0);
      const next = Number((current + delta).toFixed(3));
      const change = await actions.setConfig?.({ key, value: next, reason: "Adjusted from Telegram" });
      await edit(query.message.message_id, await configMessage(), { buttons: configButtons() });
      return answer(`${key} → ${change?.value}`);
    }
  } catch (err) {
    return answer(`Failed: ${err.message}`.slice(0, 190));
  }

  return answer();
}

async function handleUpdate(update) {
  if (update.callback_query) {
    if (!isAuthorized(update.callback_query.message)) return;
    return handleCallback(update.callback_query);
  }

  const message = update.message ?? update.edited_message;
  const text = message?.text?.trim();
  if (!text || !isAuthorized(message)) return;

  const command = LABEL_TO_COMMAND.get(text) ?? (text.startsWith("/") ? text : null);
  if (command) {
    const handled = await handleCommand(message, command);
    if (handled !== null) return;
  }

  // Free-form message: hand it to the agent.
  await call("sendChatAction", { chat_id: config.telegram.chatId, action: "typing" });
  const typing = setInterval(() => {
    call("sendChatAction", { chat_id: config.telegram.chatId, action: "typing" }).catch(() => null);
  }, 5_000);
  typing.unref?.();

  try {
    const reply = await actions.chat?.({ text, from: String(message.from?.id ?? "") });
    await send(escapeHtml(reply ?? "(no reply)"));
  } catch (err) {
    await send(`Failed: ${escapeHtml(err.message)}`);
  } finally {
    clearInterval(typing);
  }
}

async function registerCommands() {
  await call("setMyCommands", {
    commands: [
      { command: "positions", description: "Open positions with live PnL" },
      { command: "status", description: "Wallet, positions, watcher" },
      { command: "close", description: "Close position by number" },
      { command: "candidates", description: "Current screening candidates" },
      { command: "screen", description: "Run a screening cycle now" },
      { command: "manage", description: "Run a management cycle now" },
      { command: "config", description: "Settings, with toggles" },
      { command: "performance", description: "Closed-position statistics" },
      { command: "lessons", description: "What the agent has learned" },
      { command: "hivemind", description: "Swarm sync status" },
      { command: "pause", description: "Pause exit rules" },
      { command: "resume", description: "Resume exit rules" },
      { command: "menu", description: "Show the tap-to-run keyboard" },
      { command: "help", description: "Command reference" },
    ],
  });
  // Make the ☰ button beside the input open the command list on every client.
  await call("setChatMenuButton", { chat_id: config.telegram.chatId, menu_button: { type: "commands" } });
}

/** Long-poll for updates until `stopPolling()` is called. */
export async function startPolling() {
  if (!isEnabled()) {
    if (config.telegram.botToken && !config.telegram.chatId) {
      log("telegram_warn", "Bot token set but no chat id — set TELEGRAM_CHAT_ID in .env to enable control");
    }
    return { started: false };
  }
  if (polling) return { started: false, reason: "already polling" };

  polling = true;
  await registerCommands();
  log("telegram", `Polling as configured chat ${config.telegram.chatId}`);

  (async () => {
    while (polling) {
      const updates = await call("getUpdates", { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message", "edited_message", "callback_query"] });
      if (!updates) {
        // Back off on transport failure so a dead network does not spin the loop.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        handleUpdate(update).catch((err) => log("telegram_warn", `Update handling failed: ${err.message}`));
      }
    }
  })();

  return { started: true };
}

export function stopPolling() {
  polling = false;
  return { stopped: true };
}

export { escapeHtml, fmtPct, fmtMoney, fmtDuration, rangeBar };
