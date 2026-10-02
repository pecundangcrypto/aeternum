---
description: Review every open position and recommend hold, close, harvest or reduce
---

Review the open positions.

1. `node bin/aeternum.js positions` — live PnL, peak, trailing state, range status, time in range.
2. For anything that looks wrong: `node bin/aeternum.js position <mint>`.
3. `node bin/aeternum.js config` — the exit rules currently in force.

Remember the deterministic rules already run on their own: stop loss, trailing take-profit, out-of-range timer, yield floor, max hold. Do not re-litigate those. Look for what they cannot express:

- in range but pinned to the edge, in a pair still trending away
- the *reason* the position exists has expired — the volume that justified it moved elsewhere, even though fee APR has not collapsed yet
- `rangeEfficiency` well below 0.5, which means the range was mis-sized from the start
- uncollected fees worth harvesting early

For each position say hold, close, harvest or reduce, with the number that justifies it. Commands:

```
node bin/aeternum.js close --position <mint> --reason "..." --live
node bin/aeternum.js harvest --position <mint> --live
node bin/aeternum.js reduce --position <mint> --bps 5000 --reason "..." --live
```

Do not recommend closing a position that is working just to have a recommendation.
