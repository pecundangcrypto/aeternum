#!/usr/bin/env node
/**
 * Test runner.
 *
 * Deliberately offline and wallet-free: everything here must pass on a fresh
 * clone with no `.env`, so CI and a first-time contributor get the same result.
 * The parts that need the network are exercised by `aeternum candidates`, which
 * the README and CLAUDE.md both point at.
 */

import { execFileSync } from "node:child_process";
import { setQuiet } from "../src/logger.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Keep the agent's own logging out of the test output.
setQuiet(true);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? "values differ"}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message ?? "values differ"}: expected ~${expected}, got ${actual}`);
  }
}

function assertThrows(fn, message) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message ?? "expected a throw");
}

// ─── Every file parses ──────────────────────────────────────────────────────

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "data", "example", ".git", "logs"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".cjs")) found.push(full);
  }
  return found;
}

process.stdout.write("\nSyntax\n");
const files = sourceFiles(ROOT);
test(`${files.length} source files parse`, () => {
  for (const file of files) {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  }
});

// ─── Range geometry ─────────────────────────────────────────────────────────

process.stdout.write("\nRange geometry\n");
const { buildRange, resolveTokenRoles, basePrice, depositSplit } = await import("../src/chain/range.js");

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";

test("base/quote roles resolve when the quote is tokenB", () => {
  const roles = resolveTokenRoles(
    { tokenMintA: MEME, tokenMintB: SOL, tokenA: { symbol: "MEME", decimals: 6 }, tokenB: { symbol: "SOL", decimals: 9 } },
    [SOL, USDC],
  );
  assert(roles.supported);
  assertEqual(roles.baseMint, MEME, "base mint");
  assert(roles.baseIsA, "base should be tokenA");
});

test("base/quote roles resolve when the quote is tokenA", () => {
  const roles = resolveTokenRoles(
    { tokenMintA: SOL, tokenMintB: MEME, tokenA: { symbol: "SOL", decimals: 9 }, tokenB: { symbol: "MEME", decimals: 6 } },
    [SOL, USDC],
  );
  assert(roles.supported);
  assertEqual(roles.baseMint, MEME, "base mint");
  assert(!roles.baseIsA, "base should be tokenB");
});

test("SOL/USDC reports SOL priced in USDC, not the reverse", () => {
  const roles = resolveTokenRoles(
    { tokenMintA: SOL, tokenMintB: USDC, tokenA: { symbol: "SOL", decimals: 9 }, tokenB: { symbol: "USDC", decimals: 6 } },
    [SOL, USDC],
  );
  assertEqual(roles.quoteMint, USDC, "quote should be USDC");
  assertEqual(roles.baseMint, SOL, "base should be SOL");
});

test("a pool with no configured quote asset is rejected", () => {
  const roles = resolveTokenRoles(
    { tokenMintA: MEME, tokenMintB: "otherMint", tokenA: {}, tokenB: {} },
    [SOL, USDC],
  );
  assert(!roles.supported, "should be unsupported");
});

test("skew 1 puts the whole range below price when base is tokenA", () => {
  const range = buildRange({
    poolPrice: 100, tickSpacing: 8, decimalsA: 9, decimalsB: 6,
    widthPct: 10, skew: 1, baseIsA: true,
  });
  assert(range.baseUpper <= 100 * 1.01, `upper bound should sit at or below price, got ${range.baseUpper}`);
  assert(range.baseLower < 100, "lower bound should be below price");
  assert(range.downsidePct < 0 && range.upsidePct <= 1, "range should be almost entirely downside");
});

test("skew mirrors correctly when the base asset is tokenB", () => {
  const asA = buildRange({ poolPrice: 100, tickSpacing: 8, decimalsA: 9, decimalsB: 6, widthPct: 10, skew: 0.9, baseIsA: true });
  const asB = buildRange({ poolPrice: 0.01, tickSpacing: 8, decimalsA: 6, decimalsB: 9, widthPct: 10, skew: 0.9, baseIsA: false });
  // Both describe "mostly below the base price" and must agree in base terms.
  assert(asA.downsidePct < -5, `tokenA orientation downside ${asA.downsidePct}`);
  assert(asB.downsidePct < -5, `tokenB orientation downside ${asB.downsidePct}`);
  assert(asA.upsidePct < 3 && asB.upsidePct < 3, "neither orientation should have much upside");
});

test("symmetric skew gives roughly equal downside and upside", () => {
  const range = buildRange({ poolPrice: 100, tickSpacing: 1, decimalsA: 9, decimalsB: 9, widthPct: 10, skew: 0.5, baseIsA: true });
  assertClose(Math.abs(range.downsidePct), range.upsidePct, 1, "downside vs upside");
});

test("bounds land on the tick grid", () => {
  const range = buildRange({ poolPrice: 123.456, tickSpacing: 64, decimalsA: 9, decimalsB: 6, widthPct: 14, skew: 0.7, baseIsA: true });
  assertEqual(range.tickLower % 64, 0, "lower tick alignment");
  assertEqual(range.tickUpper % 64, 0, "upper tick alignment");
  assert(range.tickUpper > range.tickLower, "upper must exceed lower");
});

test("a width narrower than one tick spacing still produces a valid range", () => {
  const range = buildRange({ poolPrice: 100, tickSpacing: 32896, decimalsA: 9, decimalsB: 6, widthPct: 0.01, skew: 0.5, baseIsA: true });
  assert(range.tickUpper > range.tickLower, "range must be non-empty");
});

test("an invalid price is rejected rather than producing nonsense", () => {
  assertThrows(() => buildRange({ poolPrice: 0, tickSpacing: 8, decimalsA: 9, decimalsB: 6, widthPct: 10, skew: 0.5, baseIsA: true }));
  assertThrows(() => buildRange({ poolPrice: 100, tickSpacing: 8, decimalsA: 9, decimalsB: 6, widthPct: -5, skew: 0.5, baseIsA: true }));
});

test("deposit split is a pair of fractions, not basis points", () => {
  // The SDK reports basis points summing to 10000. Treating those as percentages
  // sizes every deposit 100x too large, so the scale is asserted explicitly.
  const midPriceSqrt = 18446744073709551616n; // sqrt price for 1:1
  const split = depositSplit({ sqrtPrice: midPriceSqrt, tickLower: -4000, tickUpper: 4000 });
  assertClose(split.ratioA + split.ratioB, 1, 0.001, "split should sum to 1");
  assert(split.ratioA > 0 && split.ratioA < 1, `ratioA out of range: ${split.ratioA}`);
});

test("a range entirely below price needs only the tokenB side", () => {
  const midPriceSqrt = 18446744073709551616n;
  const split = depositSplit({ sqrtPrice: midPriceSqrt, tickLower: -4000, tickUpper: -8 });
  assertClose(split.ratioA, 0, 0.001, "no tokenA required below price");
  assertClose(split.ratioB, 1, 0.001, "fully tokenB below price");
});

test("basePrice inverts only when the base is tokenB", () => {
  assertEqual(basePrice(50, true), 50);
  assertEqual(basePrice(0.02, false), 50);
});

// ─── Yield Score ────────────────────────────────────────────────────────────

process.stdout.write("\nYield Score\n");
const { yieldScore } = await import("../src/market/screener.js");

const pool = (overrides) => ({ feeApr: 0.5, volumeTvlRatio: 2, tvlUsd: 100_000, priceDelta24h: 0.05, ...overrides });

test("score stays within 0-100", () => {
  const extremes = [
    pool({ feeApr: 0, volumeTvlRatio: 0, tvlUsd: 0, priceDelta24h: 5 }),
    pool({ feeApr: 50, volumeTvlRatio: 500, tvlUsd: 1e9, priceDelta24h: 0 }),
  ];
  for (const candidate of extremes) {
    const score = yieldScore(candidate);
    assert(score >= 0 && score <= 100, `score out of range: ${score}`);
  }
});

test("higher fee APR scores higher, all else equal", () => {
  assert(yieldScore(pool({ feeApr: 2 })) > yieldScore(pool({ feeApr: 0.5 })), "fee APR should dominate");
});

test("volatility is penalised", () => {
  assert(yieldScore(pool({ priceDelta24h: 0.02 })) > yieldScore(pool({ priceDelta24h: 0.45 })), "stability should score higher");
});

test("log saturation separates across orders of magnitude, then saturates", () => {
  // The useful property: 50% / 200% / 600% APR must remain distinguishable, which
  // a linear scale would not manage once the ceiling is anywhere near the top of
  // the real range.
  const low = yieldScore(pool({ feeApr: 0.5 }));
  const mid = yieldScore(pool({ feeApr: 2 }));
  const high = yieldScore(pool({ feeApr: 6 }));
  assert(low < mid && mid < high, `expected a monotonic spread: ${low} / ${mid} / ${high}`);
  assert(high - low >= 8, `spread too small to rank on: ${high - low}`);

  // Above the 1200% ceiling the difference is noise, so saturating is deliberate.
  assertEqual(yieldScore(pool({ feeApr: 12 })), yieldScore(pool({ feeApr: 40 })), "should saturate past the ceiling");
});

test("missing data does not produce NaN", () => {
  const score = yieldScore({ feeApr: null, volumeTvlRatio: undefined, tvlUsd: NaN, priceDelta24h: null });
  assert(Number.isFinite(score), `score should be finite, got ${score}`);
});

// ─── Sizing and config ─────────────────────────────────────────────────────

process.stdout.write("\nSizing and config\n");
const { computeDeploySol, resolveRange, config, coerceTunable, RANGE_PRESETS } = await import("../src/config.js");

test("deploy size respects the gas reserve", () => {
  const size = computeDeploySol(config.management.gasReserveSol + 0.05);
  assert(size <= 0.05 + 1e-9, `should not exceed deployable balance, got ${size}`);
});

test("deploy size is capped by maxDeploySol", () => {
  assert(computeDeploySol(10_000) <= config.risk.maxDeploySol, "cap not applied");
});

test("deploy size scales with the wallet between the bounds", () => {
  const small = computeDeploySol(5);
  const large = computeDeploySol(50);
  assert(large >= small, "larger wallet should not deploy less");
});

test("adaptive width tracks realised volatility", () => {
  const calm = resolveRange({ priceDelta24h: 0.04 });
  const wild = resolveRange({ priceDelta24h: 0.4 });
  assert(wild.widthPct > calm.widthPct, `wild ${wild.widthPct} should exceed calm ${calm.widthPct}`);
});

test("turnover widens the range even when the net daily move is ~0", () => {
  // The failure this guards against: a pair that swings intraday and closes flat
  // reports priceDelta24h near zero, which would size the range at the floor and
  // leave it within minutes.
  const quiet = resolveRange({ priceDelta24h: 0.001, volumeTvlRatio: 1 });
  const churning = resolveRange({ priceDelta24h: 0.001, volumeTvlRatio: 16 });
  assert(churning.widthPct > quiet.widthPct, `high turnover must widen: ${quiet.widthPct} vs ${churning.widthPct}`);
  assert(churning.widthPct >= 10, `16x turnover should give a double-digit width, got ${churning.widthPct}`);
});

test("the width floor is wide enough to survive a tick or two", () => {
  const floored = resolveRange({ priceDelta24h: 0, volumeTvlRatio: 0 });
  assert(floored.widthPct >= 5, `floor too tight for a live range: ${floored.widthPct}%`);
});

test("adaptive width stays inside its clamps", () => {
  const extreme = resolveRange({ priceDelta24h: 50 });
  assert(extreme.widthPct <= config.range.maxWidthPct, "max clamp");
  const flat = resolveRange({ priceDelta24h: 0 });
  assert(flat.widthPct >= config.range.minWidthPct, "min clamp");
});

test("every range preset is well formed", () => {
  for (const [name, preset] of Object.entries(RANGE_PRESETS)) {
    assert(preset.widthPct > 0, `${name} width`);
    assert(preset.skew >= 0 && preset.skew <= 1, `${name} skew`);
    assert(typeof preset.label === "string" && preset.label.length > 0, `${name} label`);
  }
});

test("the LLM endpoint is validated, not taken on trust", () => {
  // A wrong endpoint fails every cycle silently, so it is worth rejecting early.
  assertEqual(coerceTunable("llmBaseUrl", "https://api.example.com/v1"), "https://api.example.com/v1");
  assertEqual(coerceTunable("llmBaseUrl", "http://localhost:1234/v1"), "http://localhost:1234/v1");
  assertEqual(coerceTunable("llmBaseUrl", "https://gw.example.com/v1/"), "https://gw.example.com/v1", "trailing slash");
  assertThrows(() => coerceTunable("llmBaseUrl", "not-a-url"), "a bare string should be rejected");
  assertThrows(() => coerceTunable("llmBaseUrl", "ftp://example.com/v1"), "non-http should be rejected");
  assertThrows(
    () => coerceTunable("llmBaseUrl", "https://example.com/v1/chat/completions"),
    "the full completions path should be rejected — the client appends it",
  );
});

test("any OpenAI-compatible endpoint can be configured", () => {
  // The agent needs no provider-specific behaviour, so nothing may hard-code one.
  const loop = fs.readFileSync(path.join(ROOT, "src/agent/loop.js"), "utf8");
  const hosts = loop.match(/https?:\/\/[^\s"'`]+/g) ?? [];
  assertEqual(hosts.length, 0, `the agent loop must not hard-code an endpoint, found: ${hosts.join(", ")}`);
  assert(/config\.llm/.test(loop), "the loop should read the endpoint from config");

  // The default lives in one place, and it is overridable by env and by file.
  const cfg = fs.readFileSync(path.join(ROOT, "src/config.js"), "utf8");
  assert(/LLM_BASE_URL/.test(cfg) && /u\.llmBaseUrl/.test(cfg), "baseUrl must be settable from env and user-config");
});

test("tunables are type-coerced and validated", () => {
  assertEqual(coerceTunable("trailingDropPct", "2.5"), 2.5);
  assertEqual(coerceTunable("trailingTakeProfit", "false"), false);
  assertEqual(coerceTunable("rangePreset", "tight"), "tight");
  assertThrows(() => coerceTunable("rangePreset", "nonexistent"), "unknown preset should throw");
  assertThrows(() => coerceTunable("takeProfitPct", "abc"), "non-numeric should throw");
  assertThrows(() => coerceTunable("signalMode", "sometimes"), "invalid enum should throw");
});

// ─── Tool catalogue ────────────────────────────────────────────────────────

process.stdout.write("\nTool catalogue\n");
const { TOOLS, toolsForRole, toolNames, MUTATING_TOOLS } = await import("../src/agent/tools.js");

test("the screener cannot close positions", () => {
  const names = toolNames("SCREENER");
  assert(!names.includes("close_position"), "screener must not close");
  assert(names.includes("open_position"), "screener must be able to open");
});

test("the manager cannot open positions", () => {
  const names = toolNames("MANAGER");
  assert(!names.includes("open_position"), "manager must not open");
  assert(names.includes("close_position"), "manager must be able to close");
});

test("every mutating tool requires a reason", () => {
  for (const name of MUTATING_TOOLS) {
    const tool = TOOLS.find((entry) => entry.function.name === name);
    assert(tool, `${name} missing from the catalogue`);
    if (name === "harvest_fees") continue; // harvest is non-destructive and reason-optional
    assert(tool.function.parameters.required?.includes("reason"), `${name} should require a reason`);
  }
});

test("every tool has a usable schema", () => {
  for (const tool of TOOLS) {
    assert(tool.function.name, "name");
    assert(tool.function.description?.length > 20, `${tool.function.name} needs a real description`);
    assertEqual(tool.function.parameters.type, "object", `${tool.function.name} parameters`);
  }
});

test("the chat role sees every tool", () => {
  assertEqual(toolsForRole("CHAT").length, TOOLS.length, "chat tool count");
});

// ─── Exit engine ───────────────────────────────────────────────────────────

process.stdout.write("\nExit engine\n");

// Point the stores at a scratch directory so the real ledger is never touched.
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "aeternum-test-"));
process.env.AETERNUM_DATA_DIR = scratch;

const ledger = await import("../src/store/positions.js");

function seedPosition(overrides = {}) {
  const mint = `test_${Math.random().toString(36).slice(2, 10)}`;
  ledger.openPosition({
    positionMint: mint,
    pool: "TestPool1111111111111111111111111111111111",
    pair: "TEST/SOL",
    baseMint: MEME,
    quoteMint: SOL,
    tickLower: -100,
    tickUpper: 100,
    priceLower: 90,
    priceUpper: 110,
    entryPrice: 100,
    rangePreset: "balanced",
    widthPct: 20,
    skew: 0.5,
    deploySol: 1,
    entryValueUsd: 100,
    entryValueSol: 1,
    ...overrides,
  });
  return mint;
}

const live = (overrides = {}) => ({
  status: "priceInRange",
  pnlPct: 0,
  feesUsd: 0,
  feeApr: 1,
  ...overrides,
});

test("peak only rises after confirmTicks agreeing reads", () => {
  const mint = seedPosition();
  assertEqual(ledger.confirmPeak(mint, 5, 2), false, "first read must not raise the peak");
  assertEqual(ledger.getPosition(mint).peakPnlPct, 0, "peak after one read");
  assertEqual(ledger.confirmPeak(mint, 5, 2), true, "second agreeing read should confirm");
  assertClose(ledger.getPosition(mint).peakPnlPct, 5, 0.001, "confirmed peak");
});

test("a single spiking read cannot inflate the peak", () => {
  const mint = seedPosition();
  ledger.confirmPeak(mint, 50, 2); // noise
  ledger.confirmPeak(mint, 1, 2); // reality — clears the candidate
  assertEqual(ledger.getPosition(mint).peakPnlPct, 0, "noise must not be recorded");
});

test("stop loss needs confirmation, then fires", () => {
  const mint = seedPosition();
  const first = ledger.evaluateExit(mint, live({ pnlPct: -30 }));
  assertEqual(first.action, "hold", "first read should await confirmation");
  const second = ledger.evaluateExit(mint, live({ pnlPct: -30 }));
  assertEqual(second.action, "close", "second read should close");
  assertEqual(second.signal, "stop_loss", "signal");
});

test("trailing arms at the trigger and fires on the drop", () => {
  const mint = seedPosition();
  // Two agreeing reads to confirm a peak above the arming threshold.
  ledger.evaluateExit(mint, live({ pnlPct: 6 }));
  ledger.evaluateExit(mint, live({ pnlPct: 6 }));
  assert(ledger.getPosition(mint).trailingActive, "trailing should be armed");
  assertClose(ledger.getPosition(mint).peakPnlPct, 6, 0.001, "peak");

  const first = ledger.evaluateExit(mint, live({ pnlPct: 4 }));
  assertEqual(first.action, "hold", "drop should await confirmation");
  const second = ledger.evaluateExit(mint, live({ pnlPct: 4 }));
  assertEqual(second.action, "close", "confirmed drop should close");
  assertEqual(second.signal, "trailing_tp", "signal");
});

test("trailing stays armed through a dip that does not breach the drop", () => {
  const mint = seedPosition();
  ledger.evaluateExit(mint, live({ pnlPct: 6 }));
  ledger.evaluateExit(mint, live({ pnlPct: 6 }));
  const result = ledger.evaluateExit(mint, live({ pnlPct: 5.2 }));
  assertEqual(result.action, "hold", "small dip should hold");
  assert(ledger.getPosition(mint).trailingActive, "trailing must stay armed");
});

test("an unrelated signal resets a partially confirmed one", () => {
  const mint = seedPosition();
  ledger.evaluateExit(mint, live({ pnlPct: -30 }));           // stop loss, 1 tick
  ledger.evaluateExit(mint, live({ pnlPct: 0 }));             // clears it
  const result = ledger.evaluateExit(mint, live({ pnlPct: -30 }));
  assertEqual(result.action, "hold", "confirmation should have restarted");
});

test("out-of-range dwell time is tracked and cleared on re-entry", () => {
  const mint = seedPosition();
  ledger.evaluateExit(mint, live({ status: "priceAboveRange" }));
  assert(ledger.getPosition(mint).outOfRangeSince, "should start the OOR clock");
  ledger.evaluateExit(mint, live({ status: "priceInRange" }));
  assertEqual(ledger.getPosition(mint).outOfRangeSince, null, "re-entry should clear it");
});

test("range efficiency reflects observed ticks", () => {
  const mint = seedPosition();
  ledger.evaluateExit(mint, live({ status: "priceInRange" }));
  ledger.evaluateExit(mint, live({ status: "priceInRange" }));
  ledger.evaluateExit(mint, live({ status: "priceBelowRange" }));
  ledger.evaluateExit(mint, live({ status: "priceBelowRange" }));
  assertClose(ledger.rangeEfficiency(ledger.getPosition(mint)), 0.5, 0.001, "efficiency");
});

test("accrued fees trigger a harvest rather than a close", () => {
  const mint = seedPosition();
  const result = ledger.evaluateExit(mint, live({ feesUsd: 1_000 }));
  assertEqual(result.action, "harvest", "large uncollected fees should harvest");
});

test("take-profit fires above the ceiling", () => {
  const mint = seedPosition();
  const target = config.management.takeProfitPct + 5;
  ledger.evaluateExit(mint, live({ pnlPct: target }));
  const result = ledger.evaluateExit(mint, live({ pnlPct: target }));
  assertEqual(result.action, "close", "should close");
  assert(["take_profit", "trailing_tp"].includes(result.signal), `unexpected signal ${result.signal}`);
});

test("closing writes a record and removes it from the open set", () => {
  const mint = seedPosition();
  const record = ledger.recordClose(mint, { reason: "test", pnlPct: 3.5, pnlUsd: 3.5, feesUsd: 1 });
  assert(record, "record should exist");
  assertEqual(record.pnlPct, 3.5, "pnl carried through");
  assertEqual(ledger.getPosition(mint), null, "should no longer be open");
});

// ─── Telegram keyboard ─────────────────────────────────────────────────────

process.stdout.write("\nTelegram keyboard\n");

test("every keyboard button maps to a command the bot handles", async () => {
  const { MAIN_KEYBOARD } = await import("../src/notify/telegram.js");
  const source = fs.readFileSync(path.join(ROOT, "src/notify/telegram.js"), "utf8");
  const handled = new Set([...source.matchAll(/case "(\/[a-z]+)":/g)].map((m) => m[1]));
  const rows = source.slice(source.indexOf("const KEYBOARD_ROWS"), source.indexOf("const LABEL_TO_COMMAND"));
  const commands = [...rows.matchAll(/\["[^"]+", "(\/[a-z]+)"\]/g)].map((m) => m[1]);
  assert(commands.length === MAIN_KEYBOARD.keyboard.flat().length, "every button needs a command");
  for (const command of commands) assert(handled.has(command), `button command ${command} has no handler`);
});

test("closing from a button always goes through a confirmation", () => {
  // With real capital, one mis-tap must never be enough to exit a position.
  const source = fs.readFileSync(path.join(ROOT, "src/notify/telegram.js"), "utf8");
  assert(/callback_data: `ask:close:/.test(source), "the position list must ask, not close");
  assert(/callback_data: `do:close:\$\{resolved\.mint\}`/.test(source), "the confirmation must carry the exact mint");
  const ask = source.slice(source.indexOf('data.startsWith("ask:close:")'), source.indexOf('data.startsWith("do:close:")'));
  assert(!/actions\.close/.test(ask), "asking must not close anything");
});

// ─── Paper and real books ──────────────────────────────────────────────────

process.stdout.write("\nPaper and real books\n");
const { inOwnBook } = await import("../src/chain/valuation.js");
const executor = await import("../src/agent/executor.js");
const { sweepExits } = await import("../src/cycles/manage.js");

test("each process owns exactly one book", () => {
  const restore = config.dryRun;
  try {
    config.dryRun = true;
    assert(inOwnBook("dryrun_abc"), "dry run owns paper positions");
    assert(!inOwnBook("6BrKLi56kGsx9isCumPd6JQr9qd4tUWozbhZjii4Yde6"), "dry run must not own a real position");
    config.dryRun = false;
    assert(inOwnBook("6BrKLi56kGsx9isCumPd6JQr9qd4tUWozbhZjii4Yde6"), "live owns real positions");
    assert(!inOwnBook("dryrun_abc"), "live must not own a paper position");
  } finally {
    config.dryRun = restore;
  }
});

test("a dry-run process cannot close, harvest or sweep a real position", async () => {
  // The failure this prevents: a dry-run stop loss on real capital "closes" it
  // without signing, drops it from the ledger, and leaves it open and unwatched.
  const restore = config.dryRun;
  config.dryRun = true;
  const realMint = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  ledger.openPosition({
    positionMint: realMint, pool: "TestPool1111111111111111111111111111111111", pair: "REAL/SOL",
    baseMint: MEME, quoteMint: SOL, tickLower: -100, tickUpper: 100, priceLower: 90, priceUpper: 110,
    entryPrice: 100, widthPct: 20, skew: 0.5, entryValueUsd: 100, entryValueQuote: 1,
  });
  try {
    let refused = false;
    try { await executor.closeAndSettle({ positionMint: realMint, reason: "test" }); } catch { refused = true; }
    assert(refused, "closeAndSettle must refuse");
    assert(ledger.getPosition(realMint), "the real position must still be tracked");

    const harvest = await executor.executeTool("harvest_fees", { position_mint: realMint, reason: "test" });
    assert(harvest.refused, "harvest must be refused");

    const actions = await sweepExits({ actor: "test" });
    assert(!actions.some((action) => action.position === realMint), "the sweep must not even evaluate it");
  } finally {
    ledger.forgetPosition(realMint, "test cleanup");
    config.dryRun = restore;
  }
});

// ─── Learning ──────────────────────────────────────────────────────────────

process.stdout.write("\nLearning\n");
const lessons = await import("../src/store/lessons.js");

test("duplicate lessons merge instead of accumulating", () => {
  const rule = `Unique rule ${Math.random()}`;
  const first = lessons.addLesson({ rule });
  const second = lessons.addLesson({ rule });
  assertEqual(first.id, second.id, "same lesson should merge");
  assert(second.hits >= 2, "hit count should increase");
});

test("an empty lesson is rejected", () => {
  assertThrows(() => lessons.addLesson({ rule: "   " }));
});

test("evolution refuses to act on too small a sample", () => {
  const result = lessons.evolveThresholds({ dryRun: true });
  assert(!result.evolved, "should not evolve");
  assert(result.reason.includes("closed positions") || result.proposals, "should explain why");
});

test("evolution notices a trailing stop that never arms", () => {
  // The blind spot this guards: positions peaking at 1.6–2.8% under a 4% trigger
  // and then closing at a loss leave no trailing exits in the mix, so the old
  // rules reported "thresholds already match" while the stop never fired.
  const restore = { trigger: config.management.trailingTriggerPct, drop: config.management.trailingDropPct, on: config.management.trailingTakeProfit };
  config.management.trailingTriggerPct = 4;
  config.management.trailingDropPct = 1.5;
  config.management.trailingTakeProfit = true;
  try {
    for (const [peak, final] of [[1.6, -2.9], [1.7, -3.1], [2.3, -12], [2.8, -3.6], [2.1, 2.1], [0.4, -1.7]]) {
      const mint = seedPosition();
      ledger.updatePosition(mint, { peakPnlPct: peak });
      ledger.recordClose(mint, { reason: "test", pnlPct: final, pnlUsd: final, feesUsd: 0.5 });
    }
    const result = lessons.evolveThresholds({ dryRun: true });
    const trigger = (result.proposals ?? []).find((p) => p.key === "trailingTriggerPct");
    assert(trigger, "should propose a lower trailing trigger");
    assert(trigger.to < 4 && trigger.to >= 1, `trigger should come down into a sane band, got ${trigger.to}`);
    const drop = (result.proposals ?? []).find((p) => p.key === "trailingDropPct");
    assert(drop && drop.to <= trigger.to / 2, "drop should shrink in proportion to the new trigger");
  } finally {
    config.management.trailingTriggerPct = restore.trigger;
    config.management.trailingDropPct = restore.drop;
    config.management.trailingTakeProfit = restore.on;
  }
});

test("a derived lesson is produced for an instructive close", () => {
  const lesson = lessons.deriveLessonFromClose({
    pool: "TestPool1111111111111111111111111111111111",
    pair: "TEST/SOL",
    pnlPct: -6,
    rangeEfficiency: 0.2,
    minutesHeld: 25,
    widthPct: 8,
    closeReason: "Out of range (above) for 25m",
    peakPnlPct: 0.5,
  });
  assert(lesson?.rule?.length > 20, "should write a substantive lesson");
});

test("an unremarkable close produces no lesson", () => {
  const lesson = lessons.deriveLessonFromClose({
    pool: "TestPool1111111111111111111111111111111111",
    pair: "TEST/SOL",
    pnlPct: 0.2,
    rangeEfficiency: 0.95,
    minutesHeld: 600,
    widthPct: 12,
    closeReason: "Held 10.0h",
    peakPnlPct: 0.4,
  });
  assertEqual(lesson, null, "should stay quiet");
});

// ─── Stores ────────────────────────────────────────────────────────────────

process.stdout.write("\nStores\n");
const signals = await import("../src/store/signals.js");
const blocklist = await import("../src/store/blocklist.js");
const journal = await import("../src/store/journal.js");

test("signals deduplicate inside the window", () => {
  const target = `Pool${Math.random().toString(36).slice(2, 10)}`;
  assert(signals.addSignal({ target }).queued, "first should queue");
  assert(!signals.addSignal({ target }).queued, "duplicate should be refused");
});

test("an empty signal target is rejected", () => {
  assertThrows(() => signals.addSignal({ target: "" }));
});

test("blocklisting a mint blocks the pools containing it", () => {
  const mint = `Mint${Math.random().toString(36).slice(2, 10)}`;
  blocklist.blockMint(mint, "test");
  assert(blocklist.checkBlocked({ mints: [mint] }).blocked, "should be blocked");
  blocklist.unblockMint(mint);
  assert(!blocklist.checkBlocked({ mints: [mint] }).blocked, "should be unblocked");
});

test("journal entries are truncated and recoverable", () => {
  journal.record({ kind: "skip", actor: "test", summary: "x".repeat(1_000), reason: "y".repeat(2_000) });
  const recent = journal.recent(1);
  assertEqual(recent.length, 1, "should return the entry");
  assert(recent[0].summary.length <= 300, "summary should be truncated");
});

// ─── Creator fee ───────────────────────────────────────────────────────────

process.stdout.write("\nCreator fee\n");
const { creatorFeeParams } = await import("../src/market/jupiter.js");

test("the creator fee is validated against Jupiter's limits", () => {
  const restore = { ...config.creatorFee };
  const valid = "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey";
  try {
    Object.assign(config.creatorFee, { account: valid, bps: 50 });
    const on = creatorFeeParams();
    assert(on.enabled && on.bps === 50 && on.pct === 0.5, "50 bps to a valid account should be on");

    Object.assign(config.creatorFee, { account: valid, bps: 0 });
    assert(!creatorFeeParams().enabled, "0 bps must turn it off");

    for (const bps of [49, 256, -5, NaN]) {
      Object.assign(config.creatorFee, { account: valid, bps });
      assert(!creatorFeeParams().enabled, `${bps} bps is outside 50-255 and must be dropped, not sent`);
    }

    Object.assign(config.creatorFee, { account: "not-an-address", bps: 50 });
    assert(!creatorFeeParams().enabled, "an invalid account must be dropped");

    Object.assign(config.creatorFee, { account: null, bps: 50 });
    const off = creatorFeeParams();
    assert(!off.enabled && /no referral account/.test(off.reason), "no account should explain itself");
  } finally {
    Object.assign(config.creatorFee, restore);
  }
});

test("every swap goes through the one fee-aware path", () => {
  // A second, fee-less route left in the code is an easy way to bypass both the
  // fee and its disclosure by accident.
  const sources = ["src/chain/whirlpool.js", "src/agent/executor.js", "src/market/jupiter.js"]
    .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  assert(!/\/swap\/v1\/swap|buildSwapTransaction/.test(sources), "the plain Swap API path must not come back");
  const whirlpool = fs.readFileSync(path.join(ROOT, "src/chain/whirlpool.js"), "utf8");
  assert(/jupiter\.ultraOrder\(/.test(whirlpool), "executeSwap must use the Ultra order");
});

test("swaps are partially signed, so gasless Ultra orders can land", async () => {
  // Ultra orders are often gasless: Jupiter pays the fee and signs in /execute,
  // so the transaction arrives with an empty signer slot. A full-sign call
  // rejects every one of them — no funding swap and no post-close swap could
  // ever have landed in live mode.
  const k = await import("@solana/kit");
  const me = await k.generateKeyPairSigner();
  const jupiter = await k.generateKeyPairSigner();
  const tx = k.compileTransaction(k.pipe(
    k.createTransactionMessage({ version: 0 }),
    (m) => k.setTransactionMessageFeePayer(jupiter.address, m),
    (m) => k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n }, m),
    (m) => k.appendTransactionMessageInstruction({
      programAddress: k.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      accounts: [{ address: me.address, role: k.AccountRole.READONLY_SIGNER }],
      data: new Uint8Array([1]),
    }, m),
  ));
  let fullSignThrew = false;
  try { await k.signTransaction([me.keyPair], tx); } catch { fullSignThrew = true; }
  assert(fullSignThrew, "premise: a full sign must reject a transaction with another signer outstanding");

  const whirlpool = fs.readFileSync(path.join(ROOT, "src/chain/whirlpool.js"), "utf8");
  assert(/partiallySignTransaction\(\[signer\.keyPair\]/.test(whirlpool), "Jupiter transactions must be partially signed");
  assert(!/[^y]signTransaction\(\[/.test(whirlpool), "no full-sign call may remain on the swap path");
});

test("the agent only touches SOL and what it put in itself", () => {
  // A shared wallet holds tokens that are not the agent's. Funding must never
  // count them as capital, and a close must sell only what the position returned.
  const w = fs.readFileSync(path.join(ROOT, "src/chain/whirlpool.js"), "utf8");
  const fund = w.slice(w.indexOf("async function ensureTokenBalance"), w.indexOf("async function rawTokenBalance"));
  assert(!/balances|held/.test(fund), "funding must not read existing holdings");

  const proceeds = w.slice(w.indexOf("async function swapProceedsToSol"), w.indexOf("/** Collect accrued fees"));
  assert(/- before\[mint\]/.test(proceeds), "the close swap must sell only the balance increase");
  assert(/outputMint: MINTS\.SOL/.test(proceeds), "proceeds go back to SOL, the funding asset");
  assert(/before\[mint\] == null/.test(proceeds), "with no pre-close reading it must leave the token alone");

  const close = w.slice(w.indexOf("export async function closePosition"), w.indexOf("async function swapProceedsToSol"));
  assert(close.indexOf("rawTokenBalance") < close.indexOf("orcaClosePosition"), "balances must be read before the close lands");
});

test("the fee is disclosed wherever the operator looks", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "src/runtime.js"), "utf8");
  assert(/Creator fee ON/.test(runtime) && /Creator fee off/.test(runtime), "startup must state the fee either way");
  assert(/AETERNUM_REFERRAL_FEE_BPS/.test(fs.readFileSync(path.join(ROOT, ".env.example"), "utf8")), ".env.example");
  assert(/## Creator fee/.test(fs.readFileSync(path.join(ROOT, "README.md"), "utf8")), "README section");
  assert(/creator fee/i.test(fs.readFileSync(path.join(ROOT, "src/dashboard.js"), "utf8")), "dashboard footer");
  assert(/Creator fee/.test(fs.readFileSync(path.join(ROOT, "setup.js"), "utf8")), "setup wizard");
});

// ─── Endpoint health ───────────────────────────────────────────────────────

process.stdout.write("\nEndpoint health\n");

test("a cycle that inspected nothing is treated as a failure, not a decision", () => {
  // The regression this guards: 146 cycles over 19 hours recorded an upstream
  // "quota exhausted" message as the agent's reasoning, with no alarm raised.
  const loop = fs.readFileSync(path.join(ROOT, "src/agent/loop.js"), "utf8");
  assert(/failed:\s*!inspected/.test(loop), "runAgent must mark a zero-tool-call cycle as failed");
  assert(/looksLikeProviderError/.test(loop), "provider errors must be recognised");
  assert(/agent_error/.test(loop), "the failure must be logged at error level");
});

test("provider error phrasing is recognised, and prose is not", async () => {
  const { looksLikeProviderError } = await import("../src/agent/loop.js");
  for (const bad of [
    "Your quota is exhausted. API key status: exceeded",
    "Rate limit reached for this key",
    "402 Payment Required",
    "Invalid API key provided",
    "insufficient credits remaining",
    "Unauthorized",
  ]) {
    assert(looksLikeProviderError(bad), `should flag: ${bad}`);
  }
  for (const good of [
    "Opened a ZEC/USDC position sized to the pair's 24h move.",
    "No candidate cleared the volatility filter this cycle.",
    "All positions are inside their ranges and still earning. Holding.",
  ]) {
    assert(!looksLikeProviderError(good), `must not flag: ${good}`);
  }
  assert(!looksLikeProviderError(null) && !looksLikeProviderError(undefined), "absent text is not an error");
});

test("management still sweeps exits when the model endpoint is down", () => {
  // Exits are arithmetic and must never depend on the model being reachable.
  const runtime = fs.readFileSync(path.join(ROOT, "src/runtime.js"), "utf8");
  const manageBlock = runtime.slice(runtime.indexOf("export async function manage"), runtime.indexOf("export async function chat"));
  assert(/useAgent:/.test(manageBlock), "only the judgement pass may be skipped");
  assert(!/return \{ skipped: true/.test(manageBlock), "management itself must not be skipped wholesale");
  const screenBlock = runtime.slice(runtime.indexOf("export async function screen"), runtime.indexOf("export async function manage"));
  assert(/endpointOnCooldown\(\)/.test(screenBlock), "screening should back off when the endpoint is dead");
});

// ─── PnL basis ─────────────────────────────────────────────────────────────

process.stdout.write("\nPnL basis\n");
const { quoteValue, computePnl } = await import("../src/chain/pnl.js");

test("value is denominated in the quote asset, whichever side it is on", () => {
  // baseIsA: quote is tokenB, so A converts at poolPrice.
  assertClose(quoteValue({ amountA: 2, amountB: 100, poolPrice: 50, baseIsA: true }), 200, 1e-9, "base=A");
  // baseIsB: quote is tokenA, so B converts at 1/poolPrice.
  assertClose(quoteValue({ amountA: 100, amountB: 2, poolPrice: 0.02, baseIsA: false }), 200, 1e-9, "base=B");
});

test("an unusable pool price yields no value rather than a wrong one", () => {
  assertEqual(quoteValue({ amountA: 1, amountB: 1, poolPrice: 0, baseIsA: true }), null);
  assertEqual(quoteValue({ amountA: 1, amountB: 1, poolPrice: NaN, baseIsA: true }), null);
});

test("PnL counts uncollected and harvested fees", () => {
  const r = computePnl({ valueQuote: 99, feesQuote: 1.5, harvestedQuote: 0.5, entryValueQuote: 100 });
  assertClose(r.pnlQuote, 1, 1e-9, "total return");
  assertClose(r.pnlPct, 1, 1e-9, "percentage");
});

test("harvesting never registers as a loss", () => {
  // Same economics, different split between collected and uncollected.
  const uncollected = computePnl({ valueQuote: 100, feesQuote: 2, harvestedQuote: 0, entryValueQuote: 100 });
  const harvested = computePnl({ valueQuote: 100, feesQuote: 0, harvestedQuote: 2, entryValueQuote: 100 });
  assertClose(uncollected.pnlPct, harvested.pnlPct, 1e-9, "harvesting must be PnL-neutral");
});

test("PnL is unavailable rather than wrong when the entry basis is missing", () => {
  for (const entryValueQuote of [null, undefined, 0, NaN]) {
    assertEqual(computePnl({ valueQuote: 100, entryValueQuote }).pnlPct, null, `entry=${entryValueQuote}`);
  }
});

test("no oracle price can enter the PnL path", () => {
  // The whole point of the quote basis: mixing price sources injected 0.17% of
  // phantom loss on a real position. Nothing here may reach for USD.
  const src = fs.readFileSync(path.join(ROOT, "src/chain/pnl.js"), "utf8");
  assert(!/usd|jupiter|oracle/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "pnl.js must not reference USD or an oracle outside comments");
});

// ─── Paper mode ────────────────────────────────────────────────────────────

process.stdout.write("\nPaper mode\n");
const { quotePaperLiquidity, isPaper } = await import("../src/chain/paper.js");
const paperAccount = await import("../src/store/paper-account.js");

test("paper positions are identified by their mint", () => {
  assert(isPaper("dryrun_abc123"), "dry-run mint should be paper");
  assert(!isPaper("6BrKLi56kGsx9isCumPd6JQr9qd4tUWozbhZjii4Yde6"), "a real mint should not be paper");
  assert(!isPaper(undefined), "undefined should not be paper");
});

test("paper liquidity takes the constraining side of the deposit", () => {
  const sqrtPrice = 18446744073709551616n; // 1:1
  const both = quotePaperLiquidity({ tokenMaxA: 1_000_000n, tokenMaxB: 1_000_000n, sqrtPrice, tickLower: -1000, tickUpper: 1000 });
  const onlyA = quotePaperLiquidity({ tokenMaxA: 1_000_000n, tokenMaxB: 1n, sqrtPrice, tickLower: -1000, tickUpper: 1000 });
  assert(both > 0n, "a two-sided deposit should buy liquidity");
  assert(onlyA < both, "the scarce side must cap the liquidity bought");
});

test("a one-sided range quotes liquidity from the side it actually needs", () => {
  const sqrtPrice = 18446744073709551616n;
  // Entirely below price: absorbs only tokenB, so a tokenA-only deposit buys nothing.
  const belowFromB = quotePaperLiquidity({ tokenMaxA: 0n, tokenMaxB: 1_000_000n, sqrtPrice, tickLower: -1000, tickUpper: -8 });
  assert(belowFromB > 0n, "tokenB should buy liquidity below price");
  const belowFromA = quotePaperLiquidity({ tokenMaxA: 1_000_000n, tokenMaxB: 0n, sqrtPrice, tickLower: -1000, tickUpper: -8 });
  assertEqual(belowFromA, 0n, "tokenA cannot fund a range entirely below price");
});

test("valuation defaults to not persisting, so reads cannot race the watcher", () => {
  // positions.json is read-modify-write with no cross-process lock. A status
  // command that writes could clobber peakPnlPct and break trailing take-profit.
  const valuation = fs.readFileSync(path.join(ROOT, "src/chain/valuation.js"), "utf8");
  assert(/persist = false/.test(valuation), "valuePosition must default persist to false");
  const paper = fs.readFileSync(path.join(ROOT, "src/chain/paper.js"), "utf8");
  assert(/if \(persist\)/.test(paper), "paperSnapshot must guard its write behind persist");
  const manage = fs.readFileSync(path.join(ROOT, "src/cycles/manage.js"), "utf8");
  assert(/persist: true/.test(manage), "the exit sweep must be the one that persists");
});

test("the paper account debits on open and credits on close", () => {
  paperAccount.reset();
  const start = paperAccount.balance().sol;
  paperAccount.debit(1.5, { label: "test open" });
  assertClose(paperAccount.balance().sol, start - 1.5, 0.000001, "after debit");
  paperAccount.credit(1.6, { label: "test close" });
  assertClose(paperAccount.balance().sol, start + 0.1, 0.000001, "after credit");
  assertClose(paperAccount.summary().pnlSol, 0.1, 0.000001, "paper PnL");
  paperAccount.reset();
});

test("the paper account reserves gas like a real wallet", () => {
  paperAccount.reset();
  const balance = paperAccount.balance();
  assertClose(balance.deployableSol, balance.sol - config.management.gasReserveSol, 0.000001, "gas reserve");
  paperAccount.reset();
});

// ─── Hivemind privacy ──────────────────────────────────────────────────────

process.stdout.write("\nHivemind\n");
const hivemind = await import("../src/hivemind/client.js");

test("hivemind ships with no default server", () => {
  // The guarantee is structural, not a matter of the current config file: there
  // must be no endpoint baked into the source for data to fall back to.
  const source = fs.readFileSync(path.join(ROOT, "src/hivemind/client.js"), "utf8");
  const urls = source.match(/https?:\/\/[^\s"'`]+/g) ?? [];
  assertEqual(urls.length, 0, `client must hard-code no URLs, found: ${urls.join(", ")}`);

  const configSource = fs.readFileSync(path.join(ROOT, "src/config.js"), "utf8");
  const hivemindBlock = configSource.slice(configSource.indexOf("hivemind: {"), configSource.indexOf("hivemind: {") + 600);
  assert(!/https?:\/\//.test(hivemindBlock), "config must not default hivemindUrl to an endpoint");
});

test("a blank URL disables hivemind entirely", async () => {
  const restore = config.hivemind.url;
  config.hivemind.url = null;
  try {
    assertEqual(hivemind.isEnabled(), false, "blank url should disable");
    assertEqual(await hivemind.pushLesson({ rule: "should not be sent" }), null, "push should be a no-op");
    assertEqual(await hivemind.pullLessons(), null, "pull should be a no-op");
  } finally {
    config.hivemind.url = restore;
  }
});

test("the client source never sends wallet material", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/hivemind/client.js"), "utf8");
  // Anything that could identify or drain a wallet must not appear in a request body.
  for (const forbidden of ["WALLET_PRIVATE_KEY", "walletAddress", "secretKey", "keyPair"]) {
    assert(!source.includes(forbidden), `client must not reference ${forbidden}`);
  }
});

// ─── Result ────────────────────────────────────────────────────────────────

fs.rmSync(scratch, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`);
process.exit(failed ? 1 : 0);
