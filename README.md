# Aeternum — AI liquidity bot for Orca Whirlpools on Solana

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933)
![Solana](https://img.shields.io/badge/chain-Solana-9945FF)
![Orca Whirlpools](https://img.shields.io/badge/DEX-Orca%20Whirlpools-FFD15C)

**An open-source, autonomous concentrated-liquidity (CLMM) LP agent for Orca on
Solana — AI-picked entries, rule-based exits, Telegram control.**

Aeternum screens Orca Whirlpools continuously, opens concentrated liquidity
positions sized to each pool's actual volatility, and exits them on mechanical
rules — trailing take-profit, stop loss, out-of-range timers, yield floors. An
LLM decides *what* to enter. Arithmetic decides *when* to leave.

Run it from a terminal, or headless on a VPS and control it entirely from
Telegram.

> Project inspired by [Meridian](https://github.com/yunus-0x/meridian) — see
> [CREDITS.md](CREDITS.md). All code here is original and written for Orca; MIT
> licensed.

---

## Why the split matters

Most LLM trading agents put the model in the exit path. That fails in a specific,
expensive way: the model is slow, occasionally unavailable, and sometimes wrong,
and none of those are acceptable properties for a stop loss.

Aeternum draws the line differently.

| | Who decides | Why |
|---|---|---|
| Which pool, how wide a range, how much capital | the model | needs judgement over messy, incomparable signals |
| When to close, harvest, or arm a trailing stop | deterministic rules in `src/store/positions.js` | needs to be fast, always available, and auditable |

The model can be down for an hour and every stop loss still fires on time.

---

## What it does

- **Screens pools.** Two API passes (by volume and by depth), then hard filters on
  TVL, fee APR, volume/TVL turnover, tick spacing, 24h volatility, token market
  cap, holder count and concentration, token age, and Orca's own risk rating.
  Survivors get a **Yield Score** (0-100) and only then reach the model.
- **Sizes ranges to volatility.** Range width defaults to a multiple of the pool's
  realised 24h move rather than a fixed percentage, then snaps onto the pool's
  tick grid.
- **Funds both legs.** A two-sided range needs the base asset, so the agent buys
  what the range requires through Jupiter before depositing — one-sided entries are
  a choice, not a limitation.
- **Protects positions on a fast loop.** A watcher values every position every 20
  seconds and applies the exit rules directly, so a trailing stop gives back
  seconds rather than a cron interval.
- **Learns.** Every close becomes a statistic, sometimes a written lesson, and
  after enough samples a bounded adjustment to the numeric thresholds.
- **Talks.** Full control from Telegram: positions, close by index, live config
  toggles, free-form conversation.
- **Shares, if you want it to.** An optional self-hosted hivemind pools derived
  lessons and closed-position outcomes across independent agents. No default
  server; nothing leaves your machine unless you point it somewhere.

---

## How an Orca position actually behaves

Worth internalising before running this, because every setting follows from it.

A Whirlpool position is uniform liquidity between two prices.

1. **Fees accrue only while the price is inside the range.** Out of range, the
   position earns nothing and is 100% in whichever asset just lost value.
2. **Narrow ranges earn more per dollar and leave range sooner.** Width is a
   direct trade between fee density and dwell time.
3. **Divergence loss is the opponent, not price direction.** A range that collects
   3% in fees while the pair moves 15% is a loss. Fee APR is only meaningful
   relative to realised volatility — which is why `maxPriceDelta24h` is a hard
   filter and why width is adaptive.

Aeternum describes geometry with two numbers:

- **width** — total span as a percentage of price
- **skew** — the share of that width placed *below* the base price

```
skew = 0.92   ────────────────●──     mostly below price
              enters in the quote asset, accumulates base as price falls

skew = 0.50   ───────●───────         symmetric
              needs both assets up front

skew = 0.08   ──●────────────────     mostly above price
              enters in the base asset, distributes into strength
```

Presets: `ladder_bid` (12% / 0.92), `balanced` (12% / 0.5), `tight` (5% / 0.5),
`wide` (30% / 0.5), `exit_ask` (12% / 0.08).

---

## Creator fee — read this before running live

Aeternum attaches a **0.5% referral fee to every Jupiter swap it makes**, paid to
the project's Jupiter referral account. It is **on by default**. Jupiter keeps
20% of it; the creator receives the rest.

**When you pay it.** Swaps happen when a position opens (buying the base leg a
range needs) and when it closes (selling what the position returned back to SOL). Only
the swapped portion is charged, not the whole position. Paper mode makes no real
swaps and is never charged.

**What it really costs.** On established pairs Jupiter's own fee is small — a
SOL→USDC order quoted at 0.02% without a referral and 0.50% with one. So on those
pairs this is close to half a percent *on top of* what Jupiter would charge,
not a fee you would pay anyway. On a strategy that averages a fraction of a
percent per position, that is material. Decide with that number in front of you.

**Turning it off or redirecting it** — in `.env`:

```env
AETERNUM_REFERRAL_FEE_BPS=0                 # off
AETERNUM_REFERRAL_ACCOUNT=<your account>    # collect it yourself instead
AETERNUM_REFERRAL_FEE_BPS=50                # 50–255 bps; Jupiter rejects others
```

The agent states the fee, its rate and its recipient on every start, and the
dashboard footer repeats it. If Jupiter has no fee account set up for a token,
that swap simply goes through without the fee — the creator fee can never be the
reason a swap fails.

---

## Requirements

- Node.js 20 or newer
- A Solana wallet, funded with only what you intend to risk
- An RPC endpoint — [Helius](https://helius.xyz), [Triton](https://triton.one) or
  similar. The public endpoint will rate-limit the watcher.
- Any OpenAI-compatible `/chat/completions` endpoint **with tool calling** — see
  [Model endpoint](#model-endpoint)
- Optionally a Telegram bot from [@BotFather](https://t.me/BotFather)

---

## Setup

```bash
git clone <your-fork-url> aeternum
cd aeternum
npm install
npm run setup
```

The wizard writes two files and takes about two minutes:

| File | Contains |
|---|---|
| `.env` | secrets — wallet key, RPC URL, API keys, `DRY_RUN` |
| `user-config.json` | behaviour — thresholds, range geometry, exit rules, schedule |

Secrets never go in `user-config.json`; that is the file people paste into issues.
Both are gitignored.

Prefer doing it by hand:

```bash
cp .env.example .env                          # then fill it in
cp user-config.example.json user-config.json  # every field is optional
```

### Run

```bash
npm run dev     # dry run — nothing is signed
npm start       # live
```

**Start in dry run.** Watch a few cycles, read the reports, confirm the screener
is finding what you expect, then set `DRY_RUN=false`.

### Paper mode — evaluate it for days with no private key

If `DRY_RUN=true` and no `WALLET_PRIVATE_KEY` is configured, the agent runs on a
synthetic SOL account (`paperStartingSol`, default 10) and is *structurally*
unable to sign anything — there is no key on the machine to sign with. This is the
right way to judge the strategy before funding it, and it cannot interfere with
any other bot you are running.

```bash
scripts/paper-run.sh start     # local hivemind + agent, detached, survives logout
scripts/paper-run.sh logs
scripts/paper-run.sh status
scripts/paper-run.sh stop

scripts/paper-run.sh install   # systemd units: survives reboot, restarts on crash
scripts/paper-run.sh uninstall
```

`start` uses `setsid`, which survives logout but **not** a reboot — a multi-day run
that stops when the box restarts leaves a gap you notice days later. Use `install`
for anything longer than an afternoon.

Paper positions are valued against **live pool state**, so this is not a
simulation of the market:

| | How it is produced | Accuracy |
|---|---|---|
| Position value, divergence loss | the liquidity the deposit would have bought, quoted with the same functions the on-chain program uses, valued at the pool's live sqrt price | exact |
| Range status, time in range | live `tickCurrentIndex` against the position's bounds | exact |
| Fee income | the pool's trailing 24h fee flow × the share of active liquidity the position would represent, accrued only while in range | estimated |

Every paper snapshot is flagged `estimated: true`, and the exit engine, reports
and Telegram output treat it identically to a real position — so trailing
take-profit, stop losses and out-of-range timers all exercise the same code paths
they will in live mode.

The paper account debits on open and credits value plus accrued fees on close, so
`aeternum status` shows a running result for the whole run, and
`aeternum performance` builds a real track record from it.

### Run under pm2

```bash
npm run pm2:start   # always via ecosystem.config.cjs, never `pm2 start index.js`
pm2 save
```

`ecosystem.config.cjs` pins the working directory. A pm2 process started from the
wrong directory writes a second, empty `data/` ledger and loses track of open
positions. After any change:

```bash
npm install && npm run pm2:restart && npm run pm2:logs
```

Run exactly one instance. Two Telegram pollers on one bot token fight each other
(HTTP 409) and two watchers would double-submit closes.

---

## Using it

### Terminal

`npm start` gives a REPL with a countdown to the next cycle:

```
[manage 4m12s | screen 21m03s] >
```

| Command | Does |
|---|---|
| `/status` | wallet, positions, watcher, hivemind |
| `/positions` | open positions with live PnL, peak, range state |
| `/candidates` | screening pass without deploying |
| `/screen` `/manage` | run a full cycle now |
| `/close <n>` | close position n |
| `/config` | current configuration |
| `/performance` | closed-position statistics |
| `/lessons` `/evolve` | what it learned; retune thresholds |
| `/pause` `/resume` | stop or resume the exit rules |
| anything else | a message to the agent |

### Telegram

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=987654321
TELEGRAM_ALLOWED_USER_IDS=987654321   # required for group control
```

The chat id must be set explicitly — the bot never adopts whoever messages it
first, because that would hand control to anyone who finds it. Rather than dig it
out of raw API JSON, put the token in `.env`, send the bot a message from your own
account, and run:

```bash
node scripts/telegram-link.js          # shows the chat and user it found
node scripts/telegram-link.js --write  # saves TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_IDS
```

It only accepts a private chat, and never prints the token. In groups, only
`allowedUserIds` may issue commands.

`/positions` renders each position with a range bar and marks an armed trailing
stop:

```
1. SOL/ZEC 🔒
───────●──── in range
PnL +5.20% $12.40 | peak +6.10%
Fees $3.10 | fee APR 180% | held 2.4h
```

`/close 1` closes by list index — never by raw mint, so a typo cannot touch the
wrong position. `/config` returns inline buttons that toggle trailing TP and nudge
the TP, SL, trigger and drop values live. Any non-command message goes to the
agent.

Notifications fire on open, close (with the trigger that caused it), and cycle
reports.

### CLI

Every capability as a one-shot command with JSON output:

```bash
aeternum candidates --limit 5          # what the screener sees right now
aeternum pool <address>                # deep dive, including other tick spacings
aeternum token BONK                    # token research
aeternum positions                     # live PnL
aeternum performance                   # closed-position statistics
aeternum decisions --kind close        # why it closed things
aeternum config set trailingDropPct 1  # change a setting
aeternum evolve --dry-run              # proposed threshold changes, unapplied
aeternum ask "is the ZEC pool worth entering?"
```

Write commands default to dry run and require `--live` to sign anything:

```bash
aeternum open --pool <addr> --sol 1 --width 14 --skew 0.9 --reason "..." --live
aeternum close --position <mint> --reason "took profit" --live
```

`npm install -g .` puts `aeternum` on your PATH; otherwise `node bin/aeternum.js`.

### Claude Code

Working inside the repo with [Claude Code](https://claude.com/claude-code) gives
slash commands that drive the CLI: `/screen`, `/manage`, `/positions`,
`/candidates`, `/pool`, `/performance`, `/tune`. Two subagents — `screener` and
`manager` — mirror the autonomous roles for interactive use.

---

## Dashboard

A read-only status page written for someone who has not run a liquidity position
before. It leads with one number and then explains it.

- **One headline: what the agent's positions returned** — and it is exactly what
  the rest of the page decomposes, fees plus price movement. Leading with the SOL
  balance instead made the page contradict itself: a positive headline sitting
  above a negative breakdown, because the balance also contains SOL's own price
  moves. Those are reported on their own line, never credited to the agent.
- **Where the return came from** — fee income and price movement as separate,
  signed bars against a zero line. This is the split newcomers miss: a position
  can be up on fees and still down overall, and seeing the two pull against each
  other is the whole mechanic in one picture.
- **Strategy versus SOL price.** The account is funded in SOL but positions hold
  other assets, so SOL's own price moves the balance without the agent doing
  anything. That part is separated out rather than credited to the agent.
- **Per position**: a range bar showing where the price actually sits between the
  bounds and where it entered, a plain-language status ("Earning fees", "Close to
  the edge", "Out of range — 7 minutes before the agent closes it"), the return
  split into fees and price, and an expandable list of exactly what would close
  the position and how far away each trigger is.
- **Why positions ended** — the exit mix, which is the most diagnostic table on
  the page.
- **What the agent decided**, with its reasoning, and what it has learned.
- **A glossary** covering range, divergence loss, fee APR, time in range, the
  trailing stop and the SOL price effect.

The layout is bounded rather than stacked: the headline and the breakdown sit
side by side, positions flow into a responsive grid, and closed trades, exit mix,
decisions, lessons and the glossary share one tabbed panel with its own scroll and
a sticky table header. Forty closed trades and three open positions occupy the
same screen height as none — the page does not grow with the data.

Colours come from a validated categorical palette: fee income and price movement
hold fixed slots so they never swap identity, and status is always an icon plus a
label rather than colour alone.

```json
{
  "dashboardEnabled": true,
  "dashboardHost": "127.0.0.1",
  "dashboardPort": 8788,
  "dashboardToken": ""
}
```

It reads only the local JSON ledgers, which the watcher already keeps current, so
opening it costs no RPC calls and cannot compete with the agent for rate limits.
It exposes no actions — closing a position or changing a threshold stays with the
CLI and Telegram, where every change is journalled with a reason.

Loopback by default. Setting `dashboardHost` to `0.0.0.0` puts your positions and
PnL on the network, so a token is then required; if you have not set one, the
agent generates it and logs the full URL at startup:

```
[dashboard] http://192.168.1.20:8788/?token=0123456789abcdef01234567
```

Set `dashboardToken` yourself to keep the URL stable across restarts.

---

## Model endpoint

Aeternum is provider-agnostic. It needs one thing: an OpenAI-compatible
`/chat/completions` endpoint that supports **tool calling**. No provider is
hard-coded, and there is nothing to change in the code to move between them.

Two settings, either in `.env` or in `user-config.json`:

```env
LLM_BASE_URL=https://openrouter.ai/api/v1   # the API root, usually ending in /v1
LLM_API_KEY=...
```

```json
{
  "llmBaseUrl": "https://your-gateway.example.com/v1",
  "screenModel": "whatever/that-endpoint-calls-it",
  "manageModel": "whatever/that-endpoint-calls-it",
  "chatModel": "whatever/that-endpoint-calls-it"
}
```

| Endpoint | `llmBaseUrl` |
|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Any gateway or aggregator | `https://your-gateway.example.com/v1` |
| LM Studio | `http://localhost:1234/v1` |
| Ollama | `http://localhost:11434/v1` |
| vLLM / llama.cpp | `http://localhost:8000/v1` |

Model ids are whatever *your* endpoint calls them, so they change with the
provider. `.env` wins over `user-config.json`, and `OPENROUTER_API_KEY` is
accepted as an alias for `LLM_API_KEY`. Local servers usually accept any
non-empty key string.

Switch provider without a restart — the client is rebuilt when the endpoint or
key changes:

```bash
aeternum config set llmBaseUrl http://localhost:1234/v1
aeternum config set screenModel my-local-model
```

The URL is validated on the way in: it must be a full `http`/`https` URL, and it
must be the API root rather than the `/chat/completions` path, which the client
appends itself.

**Verify before a long run.** Tool calling is mandatory and not every endpoint or
model implements it properly — an endpoint that silently ignores `tools` produces
an agent that talks and never acts:

```bash
scripts/preflight.sh
```

It makes one real tool-calling round trip against the configured endpoint and
fails loudly if the model does not call the tool, alongside checking the Orca and
Jupiter APIs and confirming whether a wallet key is present.

---

## Exit rules

Checked in this order every watcher tick and every management cycle. Each needs
`confirmTicks` consecutive confirming reads before it fires.

| Rule | Default | Fires when |
|---|---|---|
| Stop loss | `-12%` | total PnL at or below the floor |
| Trailing take-profit | arm `+4%`, drop `1.5%` | peak reached the trigger, then PnL fell that far from peak |
| Take-profit | `+8%` | hard ceiling |
| Out of range | `25m` | price outside the range that long — earning nothing |
| Max hold | `72h` | stale capital regardless of PnL |
| Dead yield | `<15%` APR after `90m` | the pool stopped paying |

Why confirmation matters: a single bad RPC read that reports PnL 3% high raises
the peak, which arms the trailing stop, which then fires on the *correct* next
read — closing a healthy position at a loss. Requiring two consecutive agreeing
reads costs 20-40 seconds and removes the failure mode.

PnL is total return: current position value plus uncollected fees plus everything
already harvested, against entry value. Harvesting therefore never looks like a
loss.

---

## Yield Score

One comparable number across pools of wildly different size, built from four
log-saturating components:

| Component | Weight | Full marks at |
|---|---|---|
| Fee APR | 40 | 1200% annualised |
| Volume/TVL turnover | 25 | 20× daily |
| TVL depth | 20 | $2M |
| 24h price stability | 15 | under a 5% move |

Log saturation rather than linear, because fee APR on Orca spans 40% to 1200%+ and
a linear scale pins everything interesting at the ceiling — destroying the ranking
exactly where it matters.

It is a ranking device, not a profit forecast. Its job is to push the
obviously-unsuitable to the bottom so the model spends its reasoning on plausible
candidates.

---

## Learning

**Lessons** are short written rules injected into the prompt. Some are derived
automatically from a close — a range that left in 20 minutes, an exit where the
price sat inside the range only 30% of the hold. Some you write yourself:

```bash
aeternum lessons add "Tokenised-equity pools gap on market open — skip them overnight"
```

**Threshold evolution** adjusts the numbers, after five or more closes:

```bash
aeternum evolve --dry-run   # see the proposals and the evidence
aeternum evolve             # apply them
```

Each proposal is bounded and carries its reasoning. Examples of what it does:

- more than 40% of exits out-of-range → widen `adaptiveRangeWidthFactor`
- price in range over 90% of the time with no OOR exits → tighten it
- win rate under 40% → raise `minYieldScore` and `minFeeApr`
- stop losses over 30% of exits → lower `maxPriceDelta24h`
- trailing exits averaging far below the trigger → raise `trailingTriggerPct`

It never touches `maxPositions`, `maxDeploySol` or `stopLossPct`. Risk ceilings are
the operator's decision.

**Pool memory** records every entry and exit per pool and puts one on cooldown
after repeated losing exits, so the screener stops paying tuition on the same
lesson.

---

## Hivemind

Optional shared learning between independent agents. One agent only ever learns
from its own closes, which is a slow and expensive curriculum; a group can pool
the conclusions.

**It is off until you give it a URL.** There is no default server — that is the
point. Host your own:

```bash
npm run hivemind:serve                                    # loopback only, no auth needed
HOST=0.0.0.0 HIVEMIND_KEYS=a-long-secret npm run hivemind:serve   # reachable off-box
```

It binds `127.0.0.1` by default. A hivemind holds other operators' lessons, so it
only becomes reachable off-box once you deliberately set `HOST` — and it will warn
you if you do that without keys.

Then in `user-config.json`:

```json
{
  "hivemindUrl": "https://hivemind.example.com",
  "hivemindApiKey": "a-long-shared-secret",
  "hivemindPullMode": "auto",
  "hivemindShare": true
}
```

**What is shared:** derived lessons, and closed-position outcomes as pool address,
pair name, range preset, width, PnL %, realised fee APR, hold time, time in range,
exit reason.

**What is never shared:** private keys, wallet addresses, balances, position
mints, transaction signatures, USD amounts. Your identity on the swarm is a random
`agent_<hex>` id with no relationship to your wallet.

Trust is agreement, not authority. The server fingerprints each lesson and counts
how many *distinct* agents independently reported it; lessons are served in that
order and never echoed back to their own author as consensus. Inbound lessons
enter the prompt labelled as reports from other operators, explicitly not as
instructions.

`GET /v1/stats` and `GET /v1/presets` aggregate the pool into per-preset win rates
and median widths with sample sizes attached.

---

## Configuration

Full reference in [`user-config.example.json`](user-config.example.json), which
documents every field with its default. Edits are picked up within five minutes
without a restart.

The setup wizard offers three starting points:

| Profile | Shape |
|---|---|
| `conservative` | deep pools, wide ranges, tight stops, 2 positions |
| `balanced` | the shipped defaults |
| `aggressive` | thin high-yield pools, narrow ranges, fast exits, 4 positions |

Settings worth understanding before going live:

| Field | Default | Why it matters |
|---|---|---|
| `maxPositions` | `3` | hard ceiling on concurrent exposure |
| `positionSizePct` | `0.35` | share of deployable balance per position, so size compounds |
| `maxPriceDelta24h` | `0.6` | the main volatility gate; the biggest single lever on divergence loss |
| `adaptiveRangeWidthFactor` | `0.75` | range width as a multiple of realised 24h move |
| `confirmTicks` | `2` | reads required before any exit fires |
| `watcherIntervalSec` | `20` | how quickly a trailing stop reacts |
| `onePositionPerToken` | `true` | two ranges on one asset is a doubled bet, not diversification |

---

## Architecture

```
index.js                  process entry — runtime + REPL
bin/aeternum.js           CLI
setup.js                  setup wizard

src/
  config.js               layered config: defaults < user-config.json < env
  paths.js                absolute paths, so pm2 cannot split the ledger
  runtime.js              cron, watcher, Telegram wiring, chat history
  watcher.js              fast loop that drives trailing take-profit

  chain/
    solana.js             RPC, wallet, Orca SDK bootstrap, balances
    range.js              tick maths, width+skew geometry, base/quote roles
    whirlpool.js          open, close, harvest, reduce, swap, live valuation

  market/
    orca-api.js           pool discovery and statistics
    jupiter.js            token research, pricing, swap routing
    screener.js           hard filters, Yield Score, enrichment

  agent/
    tools.js              tool schemas and per-role scoping
    prompt.js             system prompts with live state injected
    executor.js           dispatch and every risk gate
    loop.js               the reason-act loop

  cycles/
    screen.js             screening cycle
    manage.js             deterministic sweep, then the judgement pass
    reconcile.js          ledger vs. chain, and adopting external positions

  store/                  JSON ledgers, written atomically
    positions.js          position ledger and the exit engine
    journal.js            decision journal
    lessons.js            lessons, statistics, threshold evolution
    pool-memory.js        per-pool history and cooldowns
    blocklist.js          permanent mint and pool blocks
    signals.js            external signal queue

  notify/telegram.js      Telegram control surface
  hivemind/client.js      swarm sync

  dashboard.js            read-only status page (server + page)
  dashboard-state.js      derives the beginner-facing numbers from the ledgers
  chain/paper.js          paper position valuation for keyless runs
  chain/valuation.js      routes a position to paper or on-chain valuation
  store/paper-account.js  synthetic SOL account for paper mode

hivemind-server/          dependency-free reference server
scripts/paper-run.sh      detached paper run: local hivemind + agent
data/                     runtime state (gitignored)
```

State lives in `data/` as plain JSON. Back it up; read it when a decision looks
strange. `data/journal.json` records why every position was opened and closed.

---

## Signals

Anything that can run a command or write a file can nominate a pool for priority
screening:

```bash
aeternum signal add <pool-or-mint> --source discord --note "called in #alpha"
aeternum signal list
```

Signals deduplicate over 10 minutes, expire after an hour, and are consumed by the
next screening cycle before it falls back to open-market discovery. They are
nominations, not instructions — a signalled pool still has to clear every filter.

---

## Safety

Enforced in `src/agent/executor.js`, after the model has spoken and before
anything is signed. An argument in a prompt is a suggestion; a check in the
executor is a guarantee.

- Position count, position size and wallet minimums are re-checked against live
  balances at call time
- Pools are **re-screened** at the moment of the open, not trusted from the
  candidate list the model read minutes earlier
- Deploy size is capped at `maxDeploySol` and at the actual deployable balance
- Range width is clamped to `minRangeWidthPct`/`maxRangeWidthPct`
- Blocklists and pool cooldowns are checked again
- `reduce_liquidity` refuses 100% — full exits must go through `close_position`,
  which also collects fees and burns the position NFT
- Token-2022 mints with `transferHook`, `permanentDelegate`, `pausableConfig`,
  `defaultAccountState` or a transfer fee are rejected outright
- Every mutating tool requires a `reason`, which lands in the journal
- `DRY_RUN=true` simulates every write path, so the whole system can be exercised
  without signing

Refusals are returned to the model as tool results, so it adapts rather than the
cycle dying.

---

## Disclaimer

This software is provided as is, with no warranty of any kind.

Running an autonomous agent that moves funds carries real financial risk. You can
lose money through market moves, divergence loss, bugs in this software, bugs in
its dependencies, RPC failures, model errors, and mistakes of your own. Nothing
here is financial advice.

Use a dedicated wallet. Fund it with only what you are prepared to lose entirely.
Start with `DRY_RUN=true`. Read the cycle reports before trusting it unattended.

The authors accept no liability for any loss arising from use of this software.

---

## Licence

[MIT](LICENSE). Attribution and third-party credits in [CREDITS.md](CREDITS.md).
