---
description: Show what the screener currently sees, and why pools were rejected
---

Run `node bin/aeternum.js candidates --limit 10`.

Present the candidates ranked by Yield Score with fee APR, turnover, TVL, tick spacing, 24h move, holders and top-10 concentration.

Then summarise the rejections by grouping the reasons and counting them. That pattern is the useful part: if most rejections are one threshold, say which setting to change and in which direction. If nothing passed at all, say whether the filters or the market is responsible.
