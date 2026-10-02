---
description: Analyse closed-position performance and propose threshold changes
---

1. `node bin/aeternum.js performance`
2. `node bin/aeternum.js decisions --kind close --limit 20`
3. `node bin/aeternum.js evolve --dry-run`

Report win rate, average and median PnL, total fees, average hold, average time in range, and the breakdown by exit reason and range preset.

Then diagnose. The exit mix is the most informative number available:

- out-of-range dominating → ranges too narrow for the pools being picked
- stop losses dominating → volatility filter too loose
- dead-yield dominating → entering pools whose volume is already fading
- trailing exits averaging barely above the trigger → arming too early

Compare your diagnosis with what `evolve --dry-run` proposed. Say where you agree, where you do not, and why. Run `node bin/aeternum.js evolve` only if the user asks.
