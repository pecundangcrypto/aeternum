# Credits and attribution

## Inspired by Meridian

Aeternum's **shape** is inspired by [Meridian](https://github.com/yunus-0x/meridian)
by [@yunus-0x](https://github.com/yunus-0x) — an autonomous Meteora DLMM liquidity
agent for Solana. Meridian demonstrated that a set of ideas fit together well:

- a screening cycle and a management cycle on independent schedules
- an LLM tool-calling loop deciding *what* to enter, with mechanical rules deciding *when* to exit
- trailing take-profit driven by a fast poller rather than the slow cron
- a persistent ledger of positions with peak PnL and out-of-range dwell time
- a decision journal, so "why did you close that?" has an answer
- learning that feeds back into both prompts and numeric thresholds
- a shared-learning layer between independent agents ("hivemind")
- full operation from Telegram, so the agent can run headless

Thanks to the Meridian authors for publishing the design.

## What Aeternum is, and is not

**It is a different program for a different protocol.** Aeternum targets
[Orca Whirlpools](https://orca.so), not Meteora DLMM. That is not a port — the two
protocols model liquidity differently enough that almost nothing carries over:

| | Meteora DLMM | Orca Whirlpools (Aeternum) |
|---|---|---|
| Liquidity unit | discrete bins, per-bin shape | uniform liquidity between two tick indices |
| Position sizing | bins below / above the active bin | width % and skew, snapped to `tickSpacing` |
| Shape control | `spot` / `bid_ask` / `curve` distributions | geometry only: where the range sits relative to price |
| Position identity | program account | position NFT mint |
| Fee accounting | per-bin fee accrual | global fee growth vs. a per-position checkpoint |
| Data source | Meteora APIs | Orca v2 API + on-chain Whirlpool accounts |
| SDK | `@meteora-ag/dlmm` (web3.js v1) | `@orca-so/whirlpools` v8 (`@solana/kit`) |

**All source code in this repository is original and written for Orca.** No code,
prompt text, configuration file, or documentation was copied from Meridian. The
implementation, module layout, scoring model, range mathematics, exit engine,
hivemind protocol and reference server are Aeternum's own, and Aeternum adds work
that has no counterpart in Meridian:

- **Yield Score** — a log-saturating 0-100 pool ranking built from fee APR,
  volume/TVL turnover, depth and 24h price stability
- **Range geometry as width + skew** — one parameterisation that covers one-sided
  and two-sided ranges, with automatic width scaling from realised volatility
- **Automatic leg funding** — a two-sided range buys the base asset it needs
  before depositing, instead of restricting the agent to one-sided entries
- **Token-2022 hazard gate** — rejects pools whose mints carry `transferHook`,
  `permanentDelegate`, `pausableConfig` or a transfer fee, all of which are
  materially dangerous for a liquidity position
- **A self-hostable hivemind with a reference server** — agreement-weighted
  lesson sharing, with no default endpoint, so nothing leaves your machine unless
  you choose a destination

Aeternum is MIT licensed (see [LICENSE](LICENSE)). It is not affiliated with,
endorsed by, or derived from Meridian, and it is not affiliated with Orca.

## About the `example/` directory

If you cloned Meridian into `example/` while working on this project, note that
**that directory is not part of Aeternum and must not be redistributed.** Meridian
publishes no licence file, which under copyright law means all rights reserved:
you may read it, but you may not republish it — including by committing it inside
another repository.

`example/` is listed in `.gitignore` for exactly this reason. Verify before you
publish:

```bash
git check-ignore -v example/    # should print the .gitignore rule
git ls-files example/           # must print nothing
```

## Third-party software

Aeternum depends on, and is grateful for:

- [`@orca-so/whirlpools`](https://github.com/orca-so/whirlpools), `whirlpools-client`,
  `whirlpools-core`, `tx-sender` — Orca's SDK (Apache-2.0)
- [`@solana/kit`](https://github.com/anza-xyz/kit) — Solana JavaScript client (MIT)
- [Orca API](https://api.orca.so) — pool discovery, TVL and fee statistics
- [Jupiter](https://jup.ag) — token research, pricing and swap routing
- [`openai`](https://github.com/openai/openai-node) — OpenAI-compatible client (Apache-2.0)
- [`node-cron`](https://github.com/node-cron/node-cron) (ISC), [`bs58`](https://github.com/cryptocoinjs/bs58) (MIT),
  [`dotenv`](https://github.com/motdotla/dotenv) (BSD-2-Clause), [`jsonrepair`](https://github.com/josdejong/jsonrepair) (ISC)

Protocol and marketplace names are the trademarks of their respective owners and
are used here descriptively.
