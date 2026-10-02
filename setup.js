#!/usr/bin/env node
/**
 * Setup wizard.
 *
 * Writes `.env` (secrets) and `user-config.json` (behaviour) from a handful of
 * questions. Secrets never go in user-config.json — that file is the one people
 * paste into issues and screenshots.
 *
 * Safe to re-run: existing values are offered as defaults and left alone if you
 * press enter.
 */

import fs from "node:fs";
import readline from "node:readline/promises";
import bs58 from "bs58";
import { rootPath } from "./src/paths.js";

const ENV_PATH = rootPath(".env");
const CONFIG_PATH = rootPath("user-config.json");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const values = {};
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function mask(value) {
  if (!value) return "";
  return value.length <= 8 ? "••••" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function ask(question, { current = null, secret = false, required = false } = {}) {
  const hint = current ? ` [${secret ? mask(current) : current}]` : "";
  const answer = (await rl.question(`${question}${hint}: `)).trim();
  if (answer) return answer;
  if (current) return current;
  if (required) {
    console.log("  This one is required.");
    return ask(question, { current, secret, required });
  }
  return "";
}

async function askNumber(question, current) {
  const answer = await ask(question, { current: current != null ? String(current) : null });
  const parsed = Number(answer);
  return Number.isFinite(parsed) ? parsed : current;
}

async function askChoice(question, choices, current) {
  console.log(`\n${question}`);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.label}${choice.value === current ? "  (current)" : ""}`);
  });
  const answer = (await rl.question(`Choose 1-${choices.length}${current ? ` [${current}]` : ""}: `)).trim();
  const index = Number.parseInt(answer, 10);
  if (Number.isFinite(index) && index >= 1 && index <= choices.length) return choices[index - 1].value;
  return current ?? choices[0].value;
}

async function askYesNo(question, current = true) {
  const answer = (await rl.question(`${question} [${current ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
  if (!answer) return current;
  return answer.startsWith("y");
}

function validateWalletKey(value) {
  try {
    const bytes = value.startsWith("[") ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value);
    if (bytes.length !== 64) return `decoded to ${bytes.length} bytes — expected a 64-byte keypair`;
    return null;
  } catch (err) {
    return `could not decode (${err.message})`;
  }
}

const RISK_PRESETS = {
  conservative: {
    label: "Conservative — deep pools, wide ranges, tight stops",
    values: {
      maxPositions: 2,
      positionSizePct: 0.2,
      minTvlUsd: 150_000,
      maxTvlUsd: 20_000_000,
      minFeeApr: 0.25,
      minVolumeTvlRatio: 1,
      maxPriceDelta24h: 0.25,
      minMcapUsd: 5_000_000,
      minHolders: 5_000,
      minTokenAgeHours: 336,
      minYieldScore: 40,
      rangePreset: "wide",
      takeProfitPct: 6,
      stopLossPct: -8,
      trailingTriggerPct: 3,
      trailingDropPct: 1,
      outOfRangeWaitMinutes: 40,
      maxHoldHours: 168,
    },
  },
  balanced: {
    label: "Balanced — the defaults this project ships with",
    values: {
      maxPositions: 3,
      positionSizePct: 0.35,
      minTvlUsd: 25_000,
      maxTvlUsd: 3_000_000,
      minFeeApr: 0.4,
      minVolumeTvlRatio: 1.5,
      maxPriceDelta24h: 0.6,
      minMcapUsd: 250_000,
      minHolders: 400,
      minTokenAgeHours: 24,
      minYieldScore: 45,
      rangePreset: "ladder_bid",
      takeProfitPct: 8,
      stopLossPct: -12,
      trailingTriggerPct: 4,
      trailingDropPct: 1.5,
      outOfRangeWaitMinutes: 25,
      maxHoldHours: 72,
    },
  },
  aggressive: {
    label: "Aggressive — thin high-yield pools, narrow ranges, fast exits",
    values: {
      maxPositions: 4,
      positionSizePct: 0.5,
      minTvlUsd: 15_000,
      maxTvlUsd: 1_000_000,
      minFeeApr: 1.0,
      minVolumeTvlRatio: 3,
      maxPriceDelta24h: 1.0,
      minMcapUsd: 100_000,
      minHolders: 200,
      minTokenAgeHours: 6,
      minYieldScore: 55,
      rangePreset: "tight",
      takeProfitPct: 12,
      stopLossPct: -18,
      trailingTriggerPct: 5,
      trailingDropPct: 2,
      outOfRangeWaitMinutes: 12,
      maxHoldHours: 24,
    },
  },
};

async function main() {
  console.log(`
┌──────────────────────────────────────────────┐
│  Aeternum setup                              │
│  Orca Whirlpools liquidity agent             │
└──────────────────────────────────────────────┘

Two files get written:
  .env              secrets — wallet key, API keys. Never commit this.
  user-config.json  behaviour — thresholds, ranges, exit rules.

Press enter to keep an existing value.
`);

  const env = readEnv();
  const config = readConfig();

  // ── Secrets ──────────────────────────────────────────────────────────────
  console.log("── Wallet and RPC ───────────────────────────────\n");
  console.log("Use a fresh wallet funded only with what you intend to risk.");
  console.log("Base58 (Phantom export) or a JSON byte array both work.\n");

  let walletKey = await ask("Wallet private key", { current: env.WALLET_PRIVATE_KEY, secret: true, required: true });
  let keyError = validateWalletKey(walletKey);
  while (keyError) {
    console.log(`  Invalid key: ${keyError}`);
    walletKey = await ask("Wallet private key", { secret: true, required: true });
    keyError = validateWalletKey(walletKey);
  }

  console.log("\nA private RPC is strongly recommended — the public endpoint rate limits");
  console.log("hard, and the watcher polls every open position every 20 seconds.\n");
  const rpcUrl = await ask("RPC URL", { current: env.RPC_URL || "https://api.mainnet-beta.solana.com" });
  const watcherRpc = await ask("Separate RPC for the fast watcher (optional)", { current: env.WATCHER_RPC_URL });

  console.log("\n── Model ────────────────────────────────────────\n");
  console.log("Any OpenAI-compatible endpoint works. OpenRouter by default;");
  console.log("point LLM_BASE_URL at a local server (LM Studio, Ollama) to run offline.\n");
  const llmKey = await ask("OpenRouter / LLM API key", { current: env.OPENROUTER_API_KEY, secret: true, required: true });
  const llmBaseUrl = await ask("LLM base URL", { current: env.LLM_BASE_URL || "https://openrouter.ai/api/v1" });
  const model = await ask("Model", { current: config.screenModel || "anthropic/claude-sonnet-4.5" });

  console.log("\n── Telegram (optional) ──────────────────────────\n");
  console.log("Create a bot with @BotFather, then message it once and read the chat id");
  console.log("from https://api.telegram.org/bot<TOKEN>/getUpdates\n");
  const telegramToken = await ask("Bot token", { current: env.TELEGRAM_BOT_TOKEN, secret: true });
  const telegramChat = telegramToken ? await ask("Chat id", { current: env.TELEGRAM_CHAT_ID }) : "";
  const telegramUsers = telegramToken
    ? await ask("Allowed user ids for group control (comma separated, optional)", { current: env.TELEGRAM_ALLOWED_USER_IDS })
    : "";

  // ── Behaviour ────────────────────────────────────────────────────────────
  const presetKey = await askChoice(
    "── Risk profile ─────────────────────────────────",
    Object.entries(RISK_PRESETS).map(([value, preset]) => ({ value, label: preset.label })),
    "balanced",
  );
  const preset = RISK_PRESETS[presetKey].values;

  console.log("\n── Position sizing ─────────────────────────────\n");
  const deploySol = await askNumber("Minimum SOL per position", config.deploySol ?? 0.5);
  const maxDeploySol = await askNumber("Maximum SOL per position", config.maxDeploySol ?? 25);
  const maxPositions = await askNumber("Maximum concurrent positions", config.maxPositions ?? preset.maxPositions);
  const gasReserveSol = await askNumber("SOL to keep back for fees", config.gasReserveSol ?? 0.15);

  console.log("\n── Schedule ────────────────────────────────────\n");
  const screenIntervalMin = await askNumber("Screening interval, minutes", config.screenIntervalMin ?? 30);
  const manageIntervalMin = await askNumber("Management interval, minutes", config.manageIntervalMin ?? 10);
  const watcherIntervalSec = await askNumber("Watcher interval, seconds (drives trailing take-profit)", config.watcherIntervalSec ?? 20);

  console.log("\n── Hivemind (optional) ─────────────────────────\n");
  console.log("Share derived lessons and closed-position outcomes with other agents.");
  console.log("Off unless you give it a URL. Host your own with `npm run hivemind:serve`.");
  console.log("Wallet addresses, balances and signatures are never sent.\n");
  const hivemindUrl = await ask("Hivemind server URL (blank = disabled)", { current: config.hivemindUrl });
  const hivemindKey = hivemindUrl ? await ask("Hivemind API key (optional)", { current: config.hivemindApiKey, secret: true }) : "";
  const hivemindShare = hivemindUrl ? await askYesNo("Share your own lessons and outcomes?", config.hivemindShare ?? true) : false;

  console.log("\n── Creator fee ─────────────────────────────────\n");
  console.log("Aeternum adds a 0.5% referral fee to every Jupiter swap it makes, paid to");
  console.log("the project (Jupiter keeps 20% of it). Swaps happen when a position opens");
  console.log("and closes. On established pairs that is roughly half a percent on top of");
  console.log("Jupiter's own fee. Paper mode is never charged.\n");
  const keepCreatorFee = await askYesNo("Keep the creator fee on?", !(env.AETERNUM_REFERRAL_FEE_BPS === "0"));

  console.log("\n── Mode ────────────────────────────────────────\n");
  const live = await askYesNo("Trade live? (no = dry run, strongly recommended first)", false);

  // ── Write ────────────────────────────────────────────────────────────────
  const envLines = [
    "# Aeternum secrets. Never commit this file.",
    "",
    `WALLET_PRIVATE_KEY=${walletKey}`,
    `RPC_URL=${rpcUrl}`,
    ...(watcherRpc ? [`WATCHER_RPC_URL=${watcherRpc}`] : []),
    "",
    `OPENROUTER_API_KEY=${llmKey}`,
    `LLM_BASE_URL=${llmBaseUrl}`,
    "",
    ...(telegramToken
      ? [
          `TELEGRAM_BOT_TOKEN=${telegramToken}`,
          `TELEGRAM_CHAT_ID=${telegramChat}`,
          ...(telegramUsers ? [`TELEGRAM_ALLOWED_USER_IDS=${telegramUsers}`] : []),
          "",
        ]
      : []),
    ...(hivemindKey ? [`HIVEMIND_API_KEY=${hivemindKey}`, ""] : []),
    "# Creator fee: 0.5% of each Jupiter swap to the project. 0 turns it off.",
    `AETERNUM_REFERRAL_FEE_BPS=${keepCreatorFee ? (env.AETERNUM_REFERRAL_FEE_BPS && env.AETERNUM_REFERRAL_FEE_BPS !== "0" ? env.AETERNUM_REFERRAL_FEE_BPS : "50") : "0"}`,
    ...(env.AETERNUM_REFERRAL_ACCOUNT ? [`AETERNUM_REFERRAL_ACCOUNT=${env.AETERNUM_REFERRAL_ACCOUNT}`] : []),
    "",
    "# Set to false to sign real transactions.",
    `DRY_RUN=${live ? "false" : "true"}`,
    "",
  ];
  fs.writeFileSync(ENV_PATH, envLines.join("\n"));

  const nextConfig = {
    ...config,
    ...preset,
    riskProfile: presetKey,
    deploySol,
    maxDeploySol,
    maxPositions,
    gasReserveSol,
    screenIntervalMin,
    manageIntervalMin,
    watcherIntervalSec,
    screenModel: model,
    manageModel: model,
    chatModel: model,
    ...(hivemindUrl ? { hivemindUrl, hivemindShare } : {}),
  };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`);

  console.log(`
Done.

  .env               ${ENV_PATH}
  user-config.json   ${CONFIG_PATH}

Risk profile: ${presetKey}
Creator fee:  ${keepCreatorFee ? "on — 0.5% of each Jupiter swap" : "off"}
Mode:         ${live ? "LIVE — real transactions" : "DRY RUN — nothing will be signed"}

Next:
  npm run dev              start in dry run
  aeternum candidates      see what the screener finds right now
  aeternum status          wallet and ledger
${live ? "\n  Live mode is on. Watch the first few cycles before leaving it unattended.\n" : "\n  Run in dry run until the reports look right, then set DRY_RUN=false in .env.\n"}`);
}

main()
  .catch((err) => {
    console.error(`\nSetup failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
