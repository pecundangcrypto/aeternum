#!/usr/bin/env node
/**
 * Aeternum CLI.
 *
 * Every capability the agent has, reachable as a one-shot command with JSON
 * output. Useful for scripting, for driving the agent from another tool, and for
 * debugging a decision without starting the whole runtime.
 *
 * Read commands print JSON. Write commands respect DRY_RUN unless `--live` is
 * passed, and refuse to move funds without it — a mistyped command in a shell
 * should not be able to open a position.
 */

import { config, setTunable, reloadTunables } from "../src/config.js";
import { log, setLogStream } from "../src/logger.js";
import { walletBalances, walletAddress } from "../src/chain/solana.js";
import * as chain from "../src/chain/whirlpool.js";
import * as orca from "../src/market/orca-api.js";
import * as jupiter from "../src/market/jupiter.js";
import * as screener from "../src/market/screener.js";
import * as ledger from "../src/store/positions.js";
import * as lessons from "../src/store/lessons.js";
import * as journal from "../src/store/journal.js";
import * as poolMemory from "../src/store/pool-memory.js";
import * as blocklist from "../src/store/blocklist.js";
import * as signals from "../src/store/signals.js";
import * as hivemind from "../src/hivemind/client.js";
import { gateOpen, openAndTrack, closeAndSettle, executeTool, ToolRefusal } from "../src/agent/executor.js";
import { runScreenCycle } from "../src/cycles/screen.js";
import { runManageCycle } from "../src/cycles/manage.js";
import { adoptPosition, reconcile } from "../src/cycles/reconcile.js";
import { runAgent } from "../src/agent/loop.js";

const argv = process.argv.slice(2);
const command = argv[0];

/** Parse `--key value` and `--flag` into an object. */
function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

const flags = parseFlags(argv.slice(1));
const positional = argv.slice(1).filter((token) => !token.startsWith("--"));

function out(value) {
  process.stdout.write(`${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * Writes are opt-in. DRY_RUN from .env still applies unless --live is given, and
 * --live is the only thing that lets the CLI sign anything.
 */
function resolveWriteMode() {
  if (flags.live) {
    config.dryRun = false;
    return "live";
  }
  config.dryRun = true;
  return "dry-run";
}

const HELP = `aeternum — Orca Whirlpools liquidity agent CLI

State
  status                          wallet, positions, watcher, hivemind
  balance                         wallet SOL and token balances
  positions                       open positions with live PnL
  position <mint>                 full snapshot of one position
  performance                     closed-position statistics
  decisions [--limit n] [--kind k] decision journal
  config [get|set <key> <value>]  read or change configuration

Market
  candidates [--limit n]          run a screening pass
  pool <address>                  deep dive on one pool
  pools --token <mint>            every Orca pool for a token
  pair --a <mint> --b <mint>      every pool for a pair, all tick spacings
  token <mint|symbol>             token research

Actions                           (add --live to actually sign)
  open --pool <addr> [--sol n] [--width n] [--skew n] [--preset name] --reason "..."
  close --position <mint> --reason "..." [--skip-swap]
  harvest --position <mint>
  reduce --position <mint> --bps n --reason "..."
  swap --from <mint> --to <mint> --amount n --reason "..."
  adopt --position <mint>         bring an existing position under the exit rules
  reconcile                       sync the ledger with on-chain reality

Cycles
  screen [--live] [--silent]      one screening cycle
  manage [--live] [--silent]      one management cycle
  ask "question"                  one chat turn with the agent

Learning
  lessons [add "text" | pin <id> | clear]
  evolve [--dry-run]              retune thresholds from performance
  memory --pool <addr>            this agent's history in a pool

Signals
  signal add <pool|mint> [--source name] [--note "..."]
  signal list | signal clear

Blocklist
  block --mint <addr> --reason "..." | block list | unblock --mint <addr>

Hivemind
  hivemind status | hivemind pull | hivemind id
`;

async function main() {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;

    // ── State ──────────────────────────────────────────────────────────────
    case "status": {
      const balances = await walletBalances().catch((err) => ({ error: err.message }));
      out({
        dryRun: config.dryRun,
        wallet: await walletAddress().catch(() => null),
        balances,
        ledger: ledger.ledgerSummary(),
        hivemind: hivemind.status(),
        creatorFee: jupiter.creatorFeeParams(),
        rpc: config.chain.rpcUrl,
      });
      return;
    }

    case "balance":
      out(await executeTool("get_wallet_balance"));
      return;

    case "positions":
      out(await executeTool("get_positions"));
      return;

    case "position": {
      const mint = positional[0] ?? flags.position;
      if (!mint) fail("Usage: aeternum position <position-mint>");
      out(await executeTool("get_position_detail", { position_mint: mint }));
      return;
    }

    case "performance":
      out(lessons.performanceSummary({ limit: Number(flags.limit) || 200 }));
      return;

    case "decisions":
      out({ decisions: journal.recent(Number(flags.limit) || 20, flags.kind ?? null) });
      return;

    case "config": {
      const action = positional[0];
      if (!action || action === "get") {
        out(await executeTool("get_config"));
        return;
      }
      if (action === "set") {
        const [, key, ...rest] = positional;
        if (!key || !rest.length) fail('Usage: aeternum config set <key> <value>');
        const change = setTunable(key, rest.join(" "));
        out(change);
        return;
      }
      fail(`Unknown config action "${action}"`);
      return;
    }

    // ── Market ─────────────────────────────────────────────────────────────
    case "candidates": {
      const result = await screener.screenPools({ limit: Number(flags.limit) || undefined });
      out({
        scanned: result.scanned,
        count: result.candidates.length,
        candidates: result.candidates,
        rejected: flags.verbose ? result.rejected : result.rejected.slice(0, 20),
      });
      return;
    }

    case "pool": {
      const address = positional[0] ?? flags.pool;
      if (!address) fail("Usage: aeternum pool <whirlpool-address>");
      out(await screener.inspectPool(address));
      return;
    }

    case "pools": {
      const mint = flags.token ?? positional[0];
      if (!mint) fail("Usage: aeternum pools --token <mint>");
      out(await orca.poolsForToken(mint, { limit: Number(flags.limit) || 20 }));
      return;
    }

    case "pair": {
      if (!flags.a || !flags.b) fail("Usage: aeternum pair --a <mint> --b <mint>");
      out(await orca.poolsForPair(flags.a, flags.b, { limit: Number(flags.limit) || 20 }));
      return;
    }

    case "token": {
      const query = positional[0] ?? flags.query;
      if (!query) fail("Usage: aeternum token <mint-or-symbol>");
      out(await executeTool("get_token_info", { query }));
      return;
    }

    // ── Actions ────────────────────────────────────────────────────────────
    case "open": {
      const mode = resolveWriteMode();
      if (!flags.pool) fail("Usage: aeternum open --pool <addr> --reason \"...\" [--sol n] [--width n] [--skew n] [--preset name] [--live]");
      const reason = flags.reason ?? "Opened from the CLI";

      const vetted = await gateOpen({
        pool: flags.pool,
        deploy_sol: flags.sol != null ? Number(flags.sol) : undefined,
        width_pct: flags.width != null ? Number(flags.width) : undefined,
        skew: flags.skew != null ? Number(flags.skew) : undefined,
        range_preset: flags.preset,
      });
      log("cli", `${mode}: opening ${vetted.meta.pair} with ${vetted.deploySol} SOL, width ${vetted.widthPct}%, skew ${vetted.skew}`);
      const { result } = await openAndTrack(vetted, { reason, actor: "cli" });
      out(result);
      return;
    }

    case "close": {
      const mode = resolveWriteMode();
      const mint = flags.position ?? positional[0];
      if (!mint) fail('Usage: aeternum close --position <mint> --reason "..." [--live]');
      log("cli", `${mode}: closing ${mint}`);
      const result = await closeAndSettle({
        positionMint: mint,
        reason: flags.reason ?? "Closed from the CLI",
        closedBy: "cli",
        skipSwap: !!flags["skip-swap"],
      });
      out({ tx: result.tx, record: result.record, swap: result.swap });
      return;
    }

    case "harvest": {
      resolveWriteMode();
      const mint = flags.position ?? positional[0];
      if (!mint) fail("Usage: aeternum harvest --position <mint> [--live]");
      out(await executeTool("harvest_fees", { position_mint: mint, reason: flags.reason ?? "CLI harvest" }));
      return;
    }

    case "reduce": {
      resolveWriteMode();
      if (!flags.position || !flags.bps) fail('Usage: aeternum reduce --position <mint> --bps n --reason "..." [--live]');
      out(
        await executeTool("reduce_liquidity", {
          position_mint: flags.position,
          bps: Number(flags.bps),
          reason: flags.reason ?? "CLI partial withdrawal",
        }),
      );
      return;
    }

    case "swap": {
      resolveWriteMode();
      if (!flags.from || !flags.to || !flags.amount) {
        fail('Usage: aeternum swap --from <mint> --to <mint> --amount n --reason "..." [--live]');
      }
      out(
        await executeTool("swap_token", {
          input_mint: flags.from,
          output_mint: flags.to,
          amount: Number(flags.amount),
          reason: flags.reason ?? "CLI swap",
        }),
      );
      return;
    }

    case "adopt": {
      const mint = flags.position ?? positional[0];
      if (!mint) fail("Usage: aeternum adopt --position <mint>");
      out(await adoptPosition(mint, { note: flags.note ?? null }));
      return;
    }

    case "reconcile":
      out(await reconcile());
      return;

    // ── Cycles ─────────────────────────────────────────────────────────────
    case "screen": {
      resolveWriteMode();
      out(await runScreenCycle({ silent: !!flags.silent }));
      return;
    }

    case "manage": {
      resolveWriteMode();
      out(await runManageCycle({ silent: !!flags.silent, useAgent: !flags["no-agent"] }));
      return;
    }

    case "ask": {
      const question = positional.join(" ") || flags.q;
      if (!question) fail('Usage: aeternum ask "your question"');
      resolveWriteMode();
      const balances = await walletBalances().catch(() => null);
      const result = await runAgent({ role: "CHAT", goal: question, balances });
      process.stdout.write(`${result.report}\n`);
      return;
    }

    // ── Learning ───────────────────────────────────────────────────────────
    case "lessons": {
      const action = positional[0];
      if (!action) {
        out({ lessons: lessons.listLessons({ limit: Number(flags.limit) || 40 }) });
        return;
      }
      if (action === "add") {
        const rule = positional.slice(1).join(" ");
        if (!rule) fail('Usage: aeternum lessons add "your lesson"');
        out(lessons.addLesson({ rule, source: "operator" }));
        return;
      }
      if (action === "pin") {
        out(lessons.pinLesson(positional[1], true) ?? { error: "No such lesson" });
        return;
      }
      if (action === "clear") {
        out({ removed: lessons.clearLessons({ keepPinned: !flags.all }) });
        return;
      }
      fail(`Unknown lessons action "${action}"`);
      return;
    }

    case "evolve":
      out(lessons.evolveThresholds({ dryRun: !!flags["dry-run"] }));
      return;

    case "memory": {
      const pool = flags.pool ?? positional[0];
      if (!pool) fail("Usage: aeternum memory --pool <address>");
      out({ ...poolMemory.getPoolMemory(pool), cooldown: poolMemory.checkCooldown(pool) });
      return;
    }

    // ── Signals ────────────────────────────────────────────────────────────
    case "signal": {
      const action = positional[0];
      if (action === "add") {
        const target = positional[1];
        if (!target) fail("Usage: aeternum signal add <pool-or-mint> [--source name] [--note \"...\"]");
        out(signals.addSignal({ target, source: flags.source ?? "cli", note: flags.note ?? null }));
        return;
      }
      if (action === "clear") {
        out({ cleared: signals.clearSignals() });
        return;
      }
      out({ signals: signals.listSignals(Number(flags.limit) || 30) });
      return;
    }

    // ── Blocklist ──────────────────────────────────────────────────────────
    case "block": {
      if (positional[0] === "list" || (!flags.mint && !flags.pool)) {
        out(blocklist.listBlocked());
        return;
      }
      if (flags.mint) out({ blocked: blocklist.blockMint(flags.mint, flags.reason ?? "CLI") });
      if (flags.pool) out({ blocked: blocklist.blockPool(flags.pool, flags.reason ?? "CLI") });
      return;
    }

    case "unblock": {
      if (flags.mint) out({ removed: blocklist.unblockMint(flags.mint) });
      else if (flags.pool) out({ removed: blocklist.unblockPool(flags.pool) });
      else fail("Usage: aeternum unblock --mint <addr>");
      return;
    }

    // ── Hivemind ───────────────────────────────────────────────────────────
    case "hivemind": {
      const action = positional[0] ?? "status";
      if (action === "pull") {
        const [pulled] = await Promise.all([hivemind.pullLessons(), hivemind.pullPresets()]);
        out({ pulled: pulled?.length ?? 0, status: hivemind.status() });
        return;
      }
      if (action === "id") {
        out({ agentId: hivemind.agentId() });
        return;
      }
      out(hivemind.status());
      return;
    }

    default:
      fail(`Unknown command "${command}". Run \`aeternum help\`.`);
  }
}

// stdout carries JSON and nothing else, so every log line goes to stderr. That
// keeps `aeternum positions | jq` working while progress stays visible.
setLogStream("stderr");

reloadTunables();

main().catch((err) => {
  // A refusal is the safety layer working as intended, not a crash — report it as
  // a sentence. Everything else gets a stack, because it is a real fault.
  if (err instanceof ToolRefusal) {
    process.stderr.write(`Refused: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
