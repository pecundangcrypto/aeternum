# Aeternum — working notes for Claude Code

Autonomous Orca Whirlpools liquidity agent. Node 20+, ESM, no build step.

`example/` is a third-party reference clone. **Never edit it, never import from it,
and never let it reach a commit** — it is gitignored deliberately. See CREDITS.md.

## Run things

```bash
npm run dev                      # dry run, REPL
npm start                        # live
node bin/aeternum.js <command>   # one-shot CLI, JSON out
node bin/aeternum.js help
npm test                         # unit + syntax checks, no network, no wallet
```

CLI write commands default to dry run. `--live` is the only thing that signs.
Never pass it unless the user asked for execution.

## The one design rule

**The model chooses entries. Arithmetic chooses exits.**

Anything that closes a position lives in `src/store/positions.js` (`evaluateExit`)
and runs without an LLM in the path. If you find yourself adding an exit condition
to a prompt, it belongs in `evaluateExit` instead — the model is too slow and too
unreliable to be in the stop-loss path.

The corollary: risk limits live in `src/agent/executor.js`, not in prompt text. An
instruction is a suggestion; a gate is a guarantee.

## Where things live

| Concern | File |
|---|---|
| Paper valuation, keyless runs | `src/chain/paper.js`, `src/chain/valuation.js` |
| Config layering, tunables, range presets | `src/config.js` |
| Exit engine, peak tracking, trailing TP | `src/store/positions.js` |
| Risk gates, close/open pipelines | `src/agent/executor.js` |
| Tick maths, width+skew geometry, base/quote roles | `src/chain/range.js` |
| Open / close / harvest / valuation | `src/chain/whirlpool.js` |
| Hard filters, Yield Score | `src/market/screener.js` |
| Prompts | `src/agent/prompt.js` |
| Cron, watcher, Telegram wiring | `src/runtime.js` |

State is JSON under `data/`, written atomically via `src/store/json-store.js`.
Never write those files directly — go through the store modules.

## Non-obvious things that will bite you

**Pool price direction.** A Whirlpool's price is always tokenB per tokenA, and mint
ordering is a byte comparison, so the volatile asset lands on either side at
random. `resolveTokenRoles` decides which side is base and which is quote;
`buildRange` mirrors the skew when the base is tokenB. Do not assume base is
tokenA anywhere.

**Tick snapping.** Only multiples of `tickSpacing` are initializable. A width
narrower than one spacing snaps to a zero-width range, which the program rejects —
`buildRange` widens by the minimum instead. Always go through it.

**PnL includes harvested fees.** `positionSnapshot` computes total return as
current value + uncollected fees + already-harvested, against entry value.
Dropping the harvested term makes every harvest look like a loss and trips the
trailing stop.

**Uncollected fees need tick accounts.** They are not stored on the position; they
are reconstructed from the pool's global fee growth against the position's
checkpoint, which requires fetching both bounding tick arrays. That is what
`positionTicks` + `collectFeesQuote` do.

**`confirmTicks` exists for a reason.** One bad RPC read inflates the peak, which
arms the trailing stop, which then fires on the correct next read. Never bypass
`confirmPeak` / `confirmExitSignal`.

**Paper mode is keyless by construction.** `DRY_RUN=true` with no
`WALLET_PRIVATE_KEY` puts the agent on a synthetic account (`store/paper-account.js`)
and there is no key to sign with. Anything that needs "what is this position worth"
must go through `valuePosition` in `src/chain/valuation.js`, never
`positionSnapshot` directly — a paper position has no on-chain account and the
direct call will throw. Paper fee income is an estimate and every snapshot carries
`estimated: true`; never present it as realised.

**Cycles are serialised.** `exclusive()` in `src/runtime.js` stops screening and
management overlapping on the same ledger. Keep new periodic work inside it.

**One process only.** Two Telegram pollers on one token produce HTTP 409; two
watchers double-submit closes. `ecosystem.config.cjs` forces fork mode with one
instance.

**Orca API quirks.** Page size is `size` (not `limit`, which is silently ignored),
pagination is a cursor via `after`, and `sortBy` only accepts `tvl`, `volume24h`,
`volume`. Token lookup is `/tokens/{mint}` — there is no symbol search, so symbols
resolve through Jupiter.

**Telegram addresses positions by index**, never by raw mint, so a typo cannot hit
the wrong position. The index comes from the last `/positions` render.

## Style

Match what is there. Explanatory comments carry the *why* — the protocol quirk, the
failure mode being prevented — not a restatement of the code. Modules open with a
block comment explaining their role and the constraints that shaped them.

Every mutating tool takes a `reason` that lands in `data/journal.json`. Keep that
true for anything new.

## Before you finish

```bash
npm test
node bin/aeternum.js candidates --limit 3    # hits the live Orca API
```

Dry-run any change to the write paths before suggesting it is done. Do not add
dependencies without saying why.
