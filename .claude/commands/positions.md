---
description: Show open positions with live PnL and range state
---

Run `node bin/aeternum.js positions` and summarise as a compact table: pair, PnL %, peak %, whether trailing is armed, range status, fee APR, time held, time in range.

Flag anything that needs attention — out of range, PnL approaching the stop loss, `rangeEfficiency` below 0.5, or fee APR near the hold floor. Do not recommend actions unless asked; this is a read.
