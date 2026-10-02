---
description: Deep dive on one Orca pool
---

Pool address: $ARGUMENTS

1. `node bin/aeternum.js pool <address>` — stats, token research, whether it would pass screening, this agent's history in it, and the same pair at other tick spacings.
2. `node bin/aeternum.js token <base-mint>` if the token data needs more depth.

Assess:

- **Yield** — fee APR and turnover. Is the fee income real, or is TVL just small?
- **Volatility vs. range** — what width would the 24h move actually require, and what does that do to fee density?
- **Token risk** — holder concentration, age, mint and freeze authorities, Orca risk rating, Token-2022 extensions.
- **Tick spacing** — is the surfaced pool the right one for this pair, or is a sibling better?
- **History** — has this agent lost money here before?

End with a clear verdict and, if it is worth entering, a specific width and skew with the reasoning.
