/**
 * Tool catalogue.
 *
 * One schema list, three role views. A screening cycle cannot close positions
 * and a management cycle cannot open them — enforced here by construction rather
 * than by asking the model nicely in the prompt.
 *
 * Every mutating tool requires a `reason`. It lands in the decision journal, so
 * a position can always be traced back to the argument that justified it.
 */

const REASON_FIELD = {
  type: "string",
  description: "Why you are doing this, in one or two sentences. Recorded in the decision journal.",
};

export const TOOLS = [
  // ── Reads ────────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: "SOL balance, deployable SOL after the gas reserve, and every SPL token the wallet holds.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description:
        "Every open Whirlpool position with live valuation: token amounts, uncollected fees, PnL %, peak PnL, whether trailing take-profit is armed, range status and time in range.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_position_detail",
      description: "Full live snapshot of one position, including its range bounds and the pool's current fee yield.",
      parameters: {
        type: "object",
        properties: { position_mint: { type: "string", description: "Position mint address" } },
        required: ["position_mint"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_candidates",
      description:
        "Run a screening pass over Orca Whirlpools. Returns candidates that passed every configured filter, each with a Yield Score (0-100), fee APR, volume/TVL turnover, TVL, 24h price move, base-token research (holders, market cap, holder concentration, age, Orca risk rating) and this agent's own history in that pool. Also returns why pools were rejected.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "How many candidates to return (default from config)" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_pool",
      description:
        "Deep dive on one pool: full stats, token research, this agent's deploy/close history in it, whether it would currently pass screening, and the same pair's pools at other tick spacings (often a materially better position).",
      parameters: {
        type: "object",
        properties: { pool: { type: "string", description: "Whirlpool address" } },
        required: ["pool"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_token_info",
      description: "Research a token by mint or symbol: price, market cap, holders, top-10 concentration, organic-volume score, age, mint/freeze authorities, verification.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Mint address or symbol" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pool_memory",
      description: "This agent's recorded history in a pool: entries, exits, win/loss, cumulative PnL, cooldown state and operator notes.",
      parameters: {
        type: "object",
        properties: { pool: { type: "string" } },
        required: ["pool"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_performance",
      description: "Closed-position statistics: win rate, average and median PnL, total fees, average hold time, average time in range, and a breakdown by exit reason and range preset.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_decisions",
      description: "The decision journal — recent opens, closes, skips and no-deploys with the reasoning recorded at the time.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer" }, kind: { type: "string", enum: ["open", "close", "harvest", "skip", "no_deploy", "config", "error"] } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_config",
      description: "Current runtime configuration: screening thresholds, range geometry, exit rules, schedule and risk limits.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_lessons",
      description: "Lessons currently shaping decisions, pinned ones first.",
      parameters: { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false },
    },
  },

  // ── Writes ───────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "open_position",
      description:
        "Open a concentrated liquidity position. Range geometry is a width (% of price) and a skew (share of that width below the base price: 1 = fully one-sided below, entering in the quote asset and accumulating base as price falls; 0.5 = symmetric). Omit width/skew to use the configured preset. Capital is funded from SOL; any base asset the range needs is bought first.",
      parameters: {
        type: "object",
        properties: {
          pool: { type: "string", description: "Whirlpool address" },
          deploy_sol: { type: "number", description: "SOL to commit. Omit to use the configured position size." },
          width_pct: { type: "number", description: "Total range width as a percentage of price" },
          skew: { type: "number", description: "Share of the width below the base price, 0 to 1" },
          range_preset: {
            type: "string",
            enum: ["ladder_bid", "balanced", "tight", "wide", "exit_ask"],
            description: "Named geometry instead of explicit width/skew",
          },
          reason: REASON_FIELD,
          risks: { type: "array", items: { type: "string" }, description: "The concrete risks you are accepting" },
          rejected: { type: "array", items: { type: "string" }, description: "Candidates you looked at and passed over, and why" },
        },
        required: ["pool", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_position",
      description: "Withdraw all liquidity, collect fees, burn the position NFT, and sell whatever the position returned (any non-SOL token) back to SOL.",
      parameters: {
        type: "object",
        properties: {
          position_mint: { type: "string" },
          reason: REASON_FIELD,
          skip_swap: { type: "boolean", description: "Keep the returned tokens instead of selling them back to SOL" },
        },
        required: ["position_mint", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "harvest_fees",
      description: "Collect accrued fees and rewards without touching the position's liquidity.",
      parameters: {
        type: "object",
        properties: { position_mint: { type: "string" }, reason: REASON_FIELD },
        required: ["position_mint"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reduce_liquidity",
      description: "Withdraw part of a position's liquidity while leaving it open. Use to de-risk rather than fully exit.",
      parameters: {
        type: "object",
        properties: {
          position_mint: { type: "string" },
          bps: { type: "integer", description: "Basis points of liquidity to withdraw (10000 = 100%)" },
          reason: REASON_FIELD,
        },
        required: ["position_mint", "bps", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "swap_token",
      description: "Swap tokens through Jupiter. Used to realise PnL or to rebalance the wallet between quote assets.",
      parameters: {
        type: "object",
        properties: {
          input_mint: { type: "string" },
          output_mint: { type: "string" },
          amount: { type: "number", description: "Amount of the input token in human units" },
          reason: REASON_FIELD,
        },
        required: ["input_mint", "output_mint", "amount", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_position_note",
      description: "Attach a short note to an open position — visible in every later cycle and in Telegram.",
      parameters: {
        type: "object",
        properties: { position_mint: { type: "string" }, note: { type: "string" } },
        required: ["position_mint", "note"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_pool_note",
      description: "Record a durable observation about a pool, surfaced whenever it is screened again.",
      parameters: {
        type: "object",
        properties: { pool: { type: "string" }, note: { type: "string" } },
        required: ["pool", "note"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_lesson",
      description: "Save a lesson that should shape future decisions. Keep it concrete and falsifiable, not a platitude.",
      parameters: {
        type: "object",
        properties: {
          rule: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          role: { type: "string", enum: ["SCREENER", "MANAGER", "GENERAL"] },
        },
        required: ["rule"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "block_mint",
      description: "Permanently blocklist a token mint so no pool containing it is ever screened again.",
      parameters: {
        type: "object",
        properties: { mint: { type: "string" }, reason: REASON_FIELD },
        required: ["mint", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_config",
      description: "Change a runtime-tunable setting. Risk ceilings are not tunable from here.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: ["string", "number", "boolean"] },
          reason: REASON_FIELD,
        },
        required: ["key", "value", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_no_action",
      description:
        "Record that you deliberately did nothing this cycle, and why. Use this instead of forcing a marginal position — it is a valid and often correct outcome.",
      parameters: {
        type: "object",
        properties: {
          reason: REASON_FIELD,
          best_candidate: { type: "string", description: "The closest thing to a deploy, and what disqualified it" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
];

const READ_TOOLS = [
  "get_wallet_balance",
  "get_positions",
  "get_position_detail",
  "get_candidates",
  "inspect_pool",
  "get_token_info",
  "get_pool_memory",
  "get_performance",
  "get_recent_decisions",
  "get_config",
  "list_lessons",
];

const SCREENER_TOOLS = new Set([
  ...READ_TOOLS,
  "open_position",
  "add_lesson",
  "add_pool_note",
  "block_mint",
  "record_no_action",
]);

const MANAGER_TOOLS = new Set([
  ...READ_TOOLS,
  "close_position",
  "harvest_fees",
  "reduce_liquidity",
  "swap_token",
  "set_position_note",
  "add_lesson",
  "add_pool_note",
  "record_no_action",
]);

/** Tools that change state and therefore need an explicit reason. */
export const MUTATING_TOOLS = new Set([
  "open_position",
  "close_position",
  "harvest_fees",
  "reduce_liquidity",
  "swap_token",
  "block_mint",
  "update_config",
]);

export function toolsForRole(role) {
  if (role === "SCREENER") return TOOLS.filter((tool) => SCREENER_TOOLS.has(tool.function.name));
  if (role === "MANAGER") return TOOLS.filter((tool) => MANAGER_TOOLS.has(tool.function.name));
  return TOOLS; // CHAT — the operator is in the loop
}

export function toolNames(role) {
  return toolsForRole(role).map((tool) => tool.function.name);
}
