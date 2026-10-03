/**
 * Layered runtime configuration.
 *
 *   defaults  <  user-config.json  <  environment
 *
 * Secrets (wallet key, API keys) live in `.env` only. `user-config.json` holds
 * behaviour — thresholds, range geometry, exit rules — and is safe to commit to
 * a private repo or edit live: `reloadTunables()` re-reads it without a restart.
 */

import fs from "node:fs";
import dotenv from "dotenv";
import { rootPath, dataPath } from "./paths.js";

dotenv.config({ path: rootPath(".env"), quiet: true });

const USER_CONFIG = rootPath("user-config.json");

function readUserConfig() {
  if (!fs.existsSync(USER_CONFIG)) return {};
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG, "utf8")) ?? {};
  } catch {
    return {};
  }
}

let u = readUserConfig();

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function list(value, fallback) {
  if (Array.isArray(value)) return value.filter((entry) => entry != null && entry !== "");
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return fallback;
}

function text(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// Well-known mints the agent treats as "quote" — value it can measure and hold.
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

/**
 * Range geometry presets.
 *
 * A Whirlpool position is uniform liquidity between two prices, so "strategy"
 * here is purely geometric: how wide the range is, and how much of it sits
 * below the current price.
 *
 *   widthPct — total range width as a percentage of entry price
 *   skew     — share of that width placed BELOW price (1 = fully one-sided quote)
 *
 * skew ≈ 1 enters almost entirely in the quote token and accumulates the base
 * asset as price falls. skew ≈ 0 enters in the base asset and sells into
 * strength. 0.5 is a symmetric two-sided position.
 */
export const RANGE_PRESETS = {
  ladder_bid: { widthPct: 12, skew: 0.92, label: "one-sided below price, accumulates base on dips" },
  balanced: { widthPct: 12, skew: 0.5, label: "symmetric around price" },
  tight: { widthPct: 5, skew: 0.5, label: "narrow symmetric — max fee density, exits range fast" },
  wide: { widthPct: 30, skew: 0.5, label: "wide symmetric — low fee density, long dwell time" },
  exit_ask: { widthPct: 12, skew: 0.08, label: "one-sided above price, distributes base into strength" },
};

/**
 * The project's creator fee recipient: a Jupiter referral account.
 *
 * Every Jupiter swap the agent makes carries a referral fee to this account
 * unless the operator turns it off. It is disclosed at startup, in the README,
 * in the setup wizard and on the dashboard — a default that takes a cut must be
 * impossible to miss. Set it to null to ship with no creator fee.
 */
// Jupiter Ultra Referral Project; fees are claimable by the account's partner.
export const DEFAULT_REFERRAL_ACCOUNT = "8PHPvqxNDPGBNWkvxdaKk3q49y9uAMcMbbjwwjk7DupA";
export const DEFAULT_REFERRAL_FEE_BPS = 50;

/** Env value if the variable exists at all — an empty string means "disabled". */
function envOr(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : fallback;
}

export const config = {
  dryRun: bool(process.env.DRY_RUN, true),

  // Creator fee on Jupiter swaps. Env only, so it lives next to the secrets the
  // operator already reviews rather than among the strategy settings.
  creatorFee: {
    account: text(String(envOr("AETERNUM_REFERRAL_ACCOUNT", DEFAULT_REFERRAL_ACCOUNT ?? ""))),
    bps: num(envOr("AETERNUM_REFERRAL_FEE_BPS", DEFAULT_REFERRAL_FEE_BPS), DEFAULT_REFERRAL_FEE_BPS),
  },

  chain: {
    rpcUrl: text(process.env.RPC_URL, u.rpcUrl, "https://api.mainnet-beta.solana.com"),
    // A second, cheap endpoint for the high-frequency PnL watcher so it never
    // burns the main RPC's rate limit.
    watcherRpcUrl: text(process.env.WATCHER_RPC_URL, u.watcherRpcUrl) ?? null,
    priorityFeeLamports: num(process.env.PRIORITY_FEE_LAMPORTS ?? u.priorityFeeLamports, 200_000),
    slippageBps: num(u.slippageBps, 100),
    confirmTimeoutMs: num(u.confirmTimeoutMs, 90_000),
  },

  // Paper mode: evaluate the agent for days with no private key on the machine.
  // Active whenever DRY_RUN is on and no WALLET_PRIVATE_KEY is configured.
  paper: {
    startingSol: num(u.paperStartingSol, 10),
  },

  risk: {
    maxPositions: num(u.maxPositions, 3),
    maxDeploySol: num(u.maxDeploySol, 25),
    minDeploySol: num(u.minDeploySol, 0.2),
    // One position per base mint — two ranges on the same asset double the
    // directional bet while looking like diversification.
    onePositionPerToken: bool(u.onePositionPerToken, true),
  },

  screening: {
    quoteMints: list(u.quoteMints, [MINTS.SOL, MINTS.USDC]),
    minTvlUsd: num(u.minTvlUsd, 25_000),
    maxTvlUsd: num(u.maxTvlUsd, 3_000_000),
    minVolume24hUsd: num(u.minVolume24hUsd, 50_000),
    // fees24h / tvl, annualised. 0.5 = 50% APR from fees alone.
    minFeeApr: num(u.minFeeApr, 0.4),
    // volume24h / tvl. High turnover is what actually pays an LP.
    minVolumeTvlRatio: num(u.minVolumeTvlRatio, 1.5),
    maxTickSpacing: num(u.maxTickSpacing, 256),
    minTickSpacing: num(u.minTickSpacing, 1),
    // Orca publishes a 0-10 token risk score in its token metadata.
    maxTokenRisk: num(u.maxTokenRisk, 4),
    rejectWarningPools: bool(u.rejectWarningPools, true),
    // 24h absolute price move, as a ratio. Above this a concentrated range is
    // almost guaranteed to be left behind before fees cover the divergence.
    maxPriceDelta24h: num(u.maxPriceDelta24h, 0.6),
    minMcapUsd: num(u.minMcapUsd, 250_000),
    maxMcapUsd: num(u.maxMcapUsd, 500_000_000),
    minHolders: num(u.minHolders, 400),
    maxTop10Pct: num(u.maxTop10Pct, 60),
    minTokenAgeHours: num(u.minTokenAgeHours, 24),
    blockedMints: list(u.blockedMints, []),
    // Token-2022 extensions that break or endanger an LP position. A transfer
    // hook runs arbitrary code on every transfer; a permanent delegate can move
    // tokens out of any account including the pool vault; a pausable mint can
    // freeze the asset while capital is locked in a range; a transfer fee
    // silently breaks the constant-product maths the position is priced on.
    blockedTokenExtensions: list(u.blockedTokenExtensions, [
      "permanentDelegate",
      "transferHook",
      "pausableConfig",
      "defaultAccountState",
      "transferFeeConfig",
      "nonTransferable",
    ]),
    // Minimum Yield Score (0-100) before a pool is even shown to the model.
    minYieldScore: num(u.minYieldScore, 45),
    candidateLimit: num(u.candidateLimit, 8),
    // Pull signals queued by `aeternum signal add` / the webhook before screening.
    useSignals: bool(u.useSignals, true),
    signalMode: text(u.signalMode, "merge"), // merge | only
  },

  range: {
    preset: text(u.rangePreset, "ladder_bid"),
    // Explicit overrides win over the preset when set.
    widthPct: u.rangeWidthPct != null ? num(u.rangeWidthPct, null) : null,
    skew: u.rangeSkew != null ? num(u.rangeSkew, null) : null,
    minWidthPct: num(u.minRangeWidthPct, 6),
    maxWidthPct: num(u.maxRangeWidthPct, 60),
    // Scale the range by how much the pair actually moves, rather than a fixed width.
    adaptiveWidth: bool(u.adaptiveRangeWidth, true),
    adaptiveWidthFactor: num(u.adaptiveRangeWidthFactor, 0.75),
    // Turnover term. The 24h price delta is a NET change: a pair that swings ±10%
    // intraday and closes flat reports ~0, which would size a range at the floor
    // and leave it within minutes. Daily turnover does not cancel out that way, so
    // it sets an independent lower bound on width.
    adaptiveTurnoverFactor: num(u.adaptiveTurnoverFactor, 3),
  },

  management: {
    deploySol: num(u.deploySol, 0.5),
    positionSizePct: num(u.positionSizePct, 0.35),
    gasReserveSol: num(u.gasReserveSol, 0.15),
    minWalletSolToOpen: num(u.minWalletSolToOpen, 0.4),

    // ── Exit rules ────────────────────────────────────────────
    takeProfitPct: num(u.takeProfitPct, 8),
    stopLossPct: num(u.stopLossPct, -12),
    trailingTakeProfit: bool(u.trailingTakeProfit, true),
    trailingTriggerPct: num(u.trailingTriggerPct, 4),
    trailingDropPct: num(u.trailingDropPct, 1.5),
    // Consecutive confirming watcher ticks before a peak is raised or an exit
    // fires. Filters single-tick RPC noise without adding fixed delays.
    confirmTicks: num(u.confirmTicks, 2),
    outOfRangeWaitMinutes: num(u.outOfRangeWaitMinutes, 25),
    maxHoldHours: num(u.maxHoldHours, 72),
    // Below this annualised fee yield, after the grace period, capital is better
    // off redeployed.
    minFeeAprToHold: num(u.minFeeAprToHold, 0.15),
    yieldGraceMinutes: num(u.yieldGraceMinutes, 90),
    autoHarvestFeesUsd: num(u.autoHarvestFeesUsd, 5),
    // After a close, sell what the position returned (any non-SOL token) back to
    // SOL — the asset every position is funded from — so capital does not drift
    // into USDC or a base token one exit at a time. Reads the old name too.
    autoSwapToSol: bool(u.autoSwapToSol ?? u.autoSwapToQuote, true),
    // Which PnL drives the exit rules and leads the displays:
    //   "position" — the liquidity alone; matches what Orca's own page shows
    //   "net"      — after entry costs and the expected cost of selling back to SOL
    // Net is always measured and recorded for live positions either way.
    pnlBasis: u.pnlBasis === "net" ? "net" : "position",
    // Cool off a pool after repeated bad exits so the screener stops re-entering.
    reentryCooldownHours: num(u.reentryCooldownHours, 12),
    reentryCooldownLosses: num(u.reentryCooldownLosses, 2),
    // Report PnL in SOL rather than USD.
    solMode: bool(u.solMode, false),
  },

  schedule: {
    manageIntervalMin: num(u.manageIntervalMin, 10),
    screenIntervalMin: num(u.screenIntervalMin, 30),
    // Fast loop that drives trailing take-profit between cron cycles.
    watcherIntervalSec: num(u.watcherIntervalSec, 20),
    watcherEnabled: bool(u.watcherEnabled, true),
  },

  // Any OpenAI-compatible chat-completions endpoint works — the agent only needs
  // `/chat/completions` with tool calling. Gateways, aggregators and local servers
  // are all equivalent here; set the base URL and the model ids that endpoint uses.
  llm: {
    baseUrl: text(process.env.LLM_BASE_URL, u.llmBaseUrl, "https://openrouter.ai/api/v1"),
    // Prefer .env for the key. `llmApiKey` in user-config.json is honoured for
    // convenience, but that file is the one people paste into issues.
    apiKey: text(process.env.LLM_API_KEY, process.env.OPENROUTER_API_KEY, u.llmApiKey),
    screenModel: text(u.screenModel, process.env.LLM_MODEL, "anthropic/claude-sonnet-4.5"),
    manageModel: text(u.manageModel, process.env.LLM_MODEL, "anthropic/claude-sonnet-4.5"),
    chatModel: text(u.chatModel, process.env.LLM_MODEL, "anthropic/claude-sonnet-4.5"),
    temperature: num(u.temperature, 0.3),
    maxTokens: num(u.maxTokens, 4096),
    maxSteps: num(u.maxSteps, 16),
  },

  telegram: {
    botToken: text(process.env.TELEGRAM_BOT_TOKEN, u.telegramBotToken),
    chatId: text(process.env.TELEGRAM_CHAT_ID, u.telegramChatId ? String(u.telegramChatId) : null),
    allowedUserIds: list(process.env.TELEGRAM_ALLOWED_USER_IDS ?? u.telegramAllowedUserIds, []).map(String),
  },

  // Read-only status page. Serves what the ledger already knows, so opening it
  // costs no RPC calls and cannot slow the agent down.
  dashboard: {
    enabled: bool(process.env.DASHBOARD_ENABLED ?? u.dashboardEnabled, false),
    port: num(process.env.DASHBOARD_PORT ?? u.dashboardPort, 8788),
    // Loopback unless deliberately changed. Binding to a LAN exposes position
    // and PnL data, so a token is required when the host is not loopback.
    host: text(process.env.DASHBOARD_HOST, u.dashboardHost, "127.0.0.1"),
    token: text(process.env.DASHBOARD_TOKEN, u.dashboardToken),
  },

  hivemind: {
    // No default server: the swarm is opt-in and self-hosted. Point this at your
    // own `npm run hivemind:serve` instance or a peer's.
    url: text(process.env.HIVEMIND_URL, u.hivemindUrl),
    apiKey: text(process.env.HIVEMIND_API_KEY, u.hivemindApiKey),
    agentId: text(u.hivemindAgentId),
    // auto pulls shared lessons into every prompt; manual only pulls on request.
    pullMode: text(u.hivemindPullMode, "auto"),
    share: bool(u.hivemindShare, true),
    label: text(u.hivemindLabel, null),
  },
};

/**
 * Resolve the effective range geometry, optionally adapting the width to the
 * pool's realised 24h volatility.
 */
export function resolveRange({ priceDelta24h = null, volumeTvlRatio = null } = {}) {
  const preset = RANGE_PRESETS[config.range.preset] ?? RANGE_PRESETS.ladder_bid;
  const skew = config.range.skew ?? preset.skew;

  let widthPct = config.range.widthPct ?? preset.widthPct;

  if (config.range.adaptiveWidth) {
    // Two independent estimates of how much room the range needs; the wider wins.
    const netMoveWidth = Number.isFinite(priceDelta24h)
      ? Math.abs(priceDelta24h) * 100 * config.range.adaptiveWidthFactor
      : 0;
    // sqrt, because turnover rises far faster than the price range it implies:
    // 1x turnover -> 3%, 4x -> 6%, 16x -> 12%.
    const turnoverWidth = Number.isFinite(volumeTvlRatio) && volumeTvlRatio > 0
      ? Math.sqrt(volumeTvlRatio) * config.range.adaptiveTurnoverFactor
      : 0;

    const adaptive = Math.max(netMoveWidth, turnoverWidth);
    if (adaptive > 0) widthPct = adaptive;
  }

  widthPct = Math.min(config.range.maxWidthPct, Math.max(config.range.minWidthPct, widthPct));
  return {
    widthPct: Number(widthPct.toFixed(2)),
    skew: Math.min(1, Math.max(0, skew)),
    preset: config.range.preset,
  };
}

/**
 * Position size that compounds with the wallet but stays inside hard bounds.
 *
 *   clamp(deployable * positionSizePct, minDeploySol .. maxDeploySol)
 *
 * where deployable = walletSol - gasReserveSol.
 */
export function computeDeploySol(walletSol) {
  const { gasReserveSol, positionSizePct, deploySol } = config.management;
  const deployable = Math.max(0, walletSol - gasReserveSol);
  const scaled = deployable * positionSizePct;
  const floor = Math.max(config.risk.minDeploySol, deploySol);
  const size = Math.min(config.risk.maxDeploySol, Math.max(floor, scaled));
  // Never try to deploy more than the wallet can actually fund.
  return Number(Math.min(size, deployable).toFixed(3));
}

/** Keys the agent and Telegram UI are allowed to change at runtime. */
export const TUNABLE_KEYS = new Set([
  "maxPositions", "maxDeploySol", "minDeploySol", "onePositionPerToken",
  "minTvlUsd", "maxTvlUsd", "minVolume24hUsd", "minFeeApr", "minVolumeTvlRatio",
  "minTickSpacing", "maxTickSpacing", "maxTokenRisk", "rejectWarningPools",
  "maxPriceDelta24h", "minMcapUsd", "maxMcapUsd", "minHolders", "maxTop10Pct",
  "minTokenAgeHours", "minYieldScore", "candidateLimit", "useSignals", "signalMode",
  "rangePreset", "rangeWidthPct", "rangeSkew", "adaptiveRangeWidth", "adaptiveRangeWidthFactor",
  "deploySol", "positionSizePct", "gasReserveSol", "minWalletSolToOpen",
  "takeProfitPct", "stopLossPct", "trailingTakeProfit", "trailingTriggerPct",
  "trailingDropPct", "confirmTicks", "outOfRangeWaitMinutes", "maxHoldHours",
  "minFeeAprToHold", "yieldGraceMinutes", "autoHarvestFeesUsd", "autoSwapToSol", "pnlBasis",
  "reentryCooldownHours", "reentryCooldownLosses", "solMode",
  "manageIntervalMin", "screenIntervalMin", "watcherIntervalSec", "watcherEnabled",
  "llmBaseUrl", "llmApiKey",
  "screenModel", "manageModel", "chatModel", "temperature", "maxSteps", "maxTokens",
  "hivemindPullMode", "hivemindShare",
  "dashboardEnabled", "dashboardPort",
]);

const BOOL_KEYS = new Set([
  "onePositionPerToken", "rejectWarningPools", "useSignals", "adaptiveRangeWidth",
  "trailingTakeProfit", "autoSwapToSol", "solMode", "watcherEnabled", "hivemindShare",
  "dashboardEnabled",
]);

const STRING_KEYS = new Set([
  "rangePreset", "signalMode", "screenModel", "manageModel", "chatModel", "hivemindPullMode",
  "llmBaseUrl", "llmApiKey", "pnlBasis",
]);

/** Coerce a user/LLM supplied value to the type the key expects. */
export function coerceTunable(key, raw) {
  if (BOOL_KEYS.has(key)) return bool(raw, undefined) ?? false;
  if (STRING_KEYS.has(key)) {
    const value = text(String(raw));
    if (!value) throw new Error(`${key} needs a non-empty string`);
    if (key === "rangePreset" && !RANGE_PRESETS[value]) {
      throw new Error(`Unknown range preset "${value}" — pick one of ${Object.keys(RANGE_PRESETS).join(", ")}`);
    }
    if (key === "signalMode" && !["merge", "only"].includes(value)) {
      throw new Error('signalMode must be "merge" or "only"');
    }
    if (key === "llmBaseUrl") {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`llmBaseUrl must be a full URL, e.g. https://gateway.example.com/v1 — got "${value}"`);
      }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("llmBaseUrl must be http or https");
      // The client appends /chat/completions, so the base has to be the API root.
      if (/\/chat\/completions\/?$/.test(parsed.pathname)) {
        throw new Error("llmBaseUrl should be the API root (usually ending in /v1), not the /chat/completions path");
      }
      return value.replace(/\/$/, "");
    }
    if (key === "pnlBasis" && !["position", "net"].includes(value)) {
      throw new Error('pnlBasis must be "position" or "net"');
    }
    if (key === "hivemindPullMode" && !["auto", "manual"].includes(value)) {
      throw new Error('hivemindPullMode must be "auto" or "manual"');
    }
    return value;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got "${raw}"`);
  return parsed;
}

/** Persist a tunable to user-config.json and apply it to the live config. */
export function setTunable(key, raw) {
  if (!TUNABLE_KEYS.has(key)) {
    throw new Error(`"${key}" is not a runtime-tunable setting`);
  }
  const value = coerceTunable(key, raw);
  const current = readUserConfig();
  const previous = current[key];
  current[key] = value;
  fs.writeFileSync(USER_CONFIG, `${JSON.stringify(current, null, 2)}\n`);
  reloadTunables();
  return { key, previous: previous ?? null, value };
}

/** Write several tunables in one pass so the file is only rewritten once. */
export function setTunables(updates) {
  const applied = [];
  const current = readUserConfig();
  for (const [key, raw] of Object.entries(updates)) {
    if (!TUNABLE_KEYS.has(key)) throw new Error(`"${key}" is not a runtime-tunable setting`);
    const value = coerceTunable(key, raw);
    applied.push({ key, previous: current[key] ?? null, value });
    current[key] = value;
  }
  fs.writeFileSync(USER_CONFIG, `${JSON.stringify(current, null, 2)}\n`);
  reloadTunables();
  return applied;
}

/**
 * Re-read user-config.json into the live config object.
 *
 * Mutates in place so every module holding a reference sees the new values —
 * threshold evolution and Telegram edits take effect on the next cycle with no
 * restart.
 */
export function reloadTunables() {
  u = readUserConfig();
  const { risk, screening, range, management, schedule, llm, hivemind } = config;

  risk.maxPositions = num(u.maxPositions, risk.maxPositions);
  risk.maxDeploySol = num(u.maxDeploySol, risk.maxDeploySol);
  risk.minDeploySol = num(u.minDeploySol, risk.minDeploySol);
  risk.onePositionPerToken = bool(u.onePositionPerToken, risk.onePositionPerToken);

  screening.minTvlUsd = num(u.minTvlUsd, screening.minTvlUsd);
  screening.maxTvlUsd = num(u.maxTvlUsd, screening.maxTvlUsd);
  screening.minVolume24hUsd = num(u.minVolume24hUsd, screening.minVolume24hUsd);
  screening.minFeeApr = num(u.minFeeApr, screening.minFeeApr);
  screening.minVolumeTvlRatio = num(u.minVolumeTvlRatio, screening.minVolumeTvlRatio);
  screening.minTickSpacing = num(u.minTickSpacing, screening.minTickSpacing);
  screening.maxTickSpacing = num(u.maxTickSpacing, screening.maxTickSpacing);
  screening.maxTokenRisk = num(u.maxTokenRisk, screening.maxTokenRisk);
  screening.rejectWarningPools = bool(u.rejectWarningPools, screening.rejectWarningPools);
  screening.maxPriceDelta24h = num(u.maxPriceDelta24h, screening.maxPriceDelta24h);
  screening.minMcapUsd = num(u.minMcapUsd, screening.minMcapUsd);
  screening.maxMcapUsd = num(u.maxMcapUsd, screening.maxMcapUsd);
  screening.minHolders = num(u.minHolders, screening.minHolders);
  screening.maxTop10Pct = num(u.maxTop10Pct, screening.maxTop10Pct);
  screening.minTokenAgeHours = num(u.minTokenAgeHours, screening.minTokenAgeHours);
  screening.minYieldScore = num(u.minYieldScore, screening.minYieldScore);
  screening.candidateLimit = num(u.candidateLimit, screening.candidateLimit);
  screening.useSignals = bool(u.useSignals, screening.useSignals);
  screening.signalMode = text(u.signalMode, screening.signalMode);
  screening.blockedMints = list(u.blockedMints, screening.blockedMints);
  screening.blockedTokenExtensions = list(u.blockedTokenExtensions, screening.blockedTokenExtensions);
  screening.quoteMints = list(u.quoteMints, screening.quoteMints);

  range.preset = text(u.rangePreset, range.preset);
  range.widthPct = u.rangeWidthPct != null ? num(u.rangeWidthPct, range.widthPct) : null;
  range.skew = u.rangeSkew != null ? num(u.rangeSkew, range.skew) : null;
  range.adaptiveWidth = bool(u.adaptiveRangeWidth, range.adaptiveWidth);
  range.adaptiveWidthFactor = num(u.adaptiveRangeWidthFactor, range.adaptiveWidthFactor);
  range.adaptiveTurnoverFactor = num(u.adaptiveTurnoverFactor, range.adaptiveTurnoverFactor);

  for (const key of Object.keys(management)) {
    if (u[key] === undefined) continue;
    management[key] = typeof management[key] === "boolean" ? bool(u[key], management[key]) : num(u[key], management[key]);
  }

  schedule.manageIntervalMin = num(u.manageIntervalMin, schedule.manageIntervalMin);
  schedule.screenIntervalMin = num(u.screenIntervalMin, schedule.screenIntervalMin);
  schedule.watcherIntervalSec = num(u.watcherIntervalSec, schedule.watcherIntervalSec);
  schedule.watcherEnabled = bool(u.watcherEnabled, schedule.watcherEnabled);

  llm.baseUrl = text(process.env.LLM_BASE_URL, u.llmBaseUrl, llm.baseUrl);
  llm.apiKey = text(process.env.LLM_API_KEY, process.env.OPENROUTER_API_KEY, u.llmApiKey, llm.apiKey);
  llm.screenModel = text(u.screenModel, llm.screenModel);
  llm.manageModel = text(u.manageModel, llm.manageModel);
  llm.chatModel = text(u.chatModel, llm.chatModel);
  llm.temperature = num(u.temperature, llm.temperature);
  llm.maxSteps = num(u.maxSteps, llm.maxSteps);
  llm.maxTokens = num(u.maxTokens, llm.maxTokens);

  hivemind.pullMode = text(u.hivemindPullMode, hivemind.pullMode);
  hivemind.share = bool(u.hivemindShare, hivemind.share);
  hivemind.agentId = text(u.hivemindAgentId, hivemind.agentId);

  return config;
}

/** Persist a non-tunable key (used for the generated agent id). */
export function persistUserConfigKey(key, value) {
  const current = readUserConfig();
  current[key] = value;
  fs.writeFileSync(USER_CONFIG, `${JSON.stringify(current, null, 2)}\n`);
  u = current;
}

export { dataPath, rootPath };
