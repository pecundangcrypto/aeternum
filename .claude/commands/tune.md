---
description: Review the configuration against recent performance and suggest changes
---

1. `node bin/aeternum.js config`
2. `node bin/aeternum.js performance`
3. `node bin/aeternum.js candidates --limit 10` — is the funnel starving or flooded?

Work through, in this order:

**Screening** — are the filters admitting pools that lose money, or rejecting everything? Count the rejection reasons rather than guessing.

**Range geometry** — does `adaptiveRangeWidthFactor` produce widths that survive the volatility of the pools actually being entered? Compare average `rangeEfficiency` against the out-of-range exit share.

**Exit rules** — is `trailingTriggerPct` arming before there is anything worth protecting? Is `outOfRangeWaitMinutes` long enough for a wick and short enough to matter?

**Sizing** — is `positionSizePct` consistent with the win rate, or is it sizing up into a losing strategy?

Propose specific changes as `node bin/aeternum.js config set <key> <value>`, each with the number that justifies it. Never propose raising `maxDeploySol`, `maxPositions` or loosening `stopLossPct` — those are the operator's call, not a tuning decision.
