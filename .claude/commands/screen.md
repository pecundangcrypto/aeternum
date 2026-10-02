---
description: Run a screening pass and decide whether any pool deserves capital
---

Run a full screening review of Orca Whirlpools.

1. `node bin/aeternum.js status` — confirm there is a free position slot and enough deployable SOL. Stop and say so if not.
2. `node bin/aeternum.js candidates --limit 8` — read the candidates *and* the rejection list. The rejections tell you whether the filters are starving the agent or the market is genuinely thin.
3. For the strongest one or two: `node bin/aeternum.js pool <address>`. Check the `alternatives` array — the same pair at a different tick spacing is often the better position.
4. `node bin/aeternum.js memory --pool <address>` if this agent has traded it before.

Then recommend one of:

- **open** — give the pool, the SOL size, and an explicit width and skew justified by the pool's 24h price move. To execute: `node bin/aeternum.js open --pool <addr> --sol <n> --width <n> --skew <n> --reason "..." --live`
- **no deploy** — say what the closest candidate was and what disqualified it.

Be specific about risk. "Volatile token" is not an assessment; "an 18% 24h move against a 12% range means leaving range inside a day is more likely than not" is.

Never pass `--live` unless the user has explicitly asked you to execute.
