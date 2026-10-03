/**
 * The reason-act loop.
 *
 * One function drives every autonomous cycle and every chat turn: build a
 * role-scoped prompt, let the model call tools, feed results back, stop when it
 * answers in prose or runs out of steps.
 *
 * Deliberately provider-agnostic — any OpenAI-compatible endpoint works, which
 * matters because the cheapest usable model for this workload changes every few
 * months. Two compatibility quirks are handled rather than assumed away:
 * providers that reject the `system` role, and models that emit almost-JSON in
 * tool arguments.
 */

import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { config } from "../config.js";
import { log, logError } from "../logger.js";
import { buildSystemPrompt } from "./prompt.js";
import { toolsForRole, MUTATING_TOOLS } from "./tools.js";
import { executeTool } from "./executor.js";

let client = null;
let clientKey = null;

/**
 * The OpenAI-compatible client, rebuilt whenever the endpoint or key changes.
 *
 * Keying the cache on the credentials rather than caching blindly means switching
 * provider at runtime — `aeternum config set llmBaseUrl ...` — takes effect on the
 * next cycle without a restart, no matter which surface made the change.
 */
function llm() {
  const { baseUrl, apiKey } = config.llm;
  if (!apiKey) {
    throw new Error(
      "No LLM API key. Set LLM_API_KEY (or OPENROUTER_API_KEY) in .env, or llmApiKey in user-config.json",
    );
  }

  const key = `${baseUrl}::${apiKey}`;
  if (client && clientKey === key) return client;

  client = new OpenAI({
    baseURL: baseUrl,
    apiKey,
    timeout: 4 * 60_000,
    maxRetries: 2,
  });
  clientKey = key;
  log("agent", `Model endpoint: ${baseUrl}`);
  return client;
}

/** Drop the cached client. Normally unnecessary — `llm()` notices changes itself. */
export function resetClient() {
  client = null;
  clientKey = null;
}

function modelFor(role) {
  if (role === "SCREENER") return config.llm.screenModel;
  if (role === "MANAGER") return config.llm.manageModel;
  return config.llm.chatModel;
}

/**
 * Parse tool arguments defensively.
 * Small models routinely emit trailing commas or unquoted keys; repairing is
 * strictly better than failing a whole cycle on a syntax slip.
 */
function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(jsonrepair(raw));
    } catch {
      return { __unparsed: String(raw).slice(0, 400) };
    }
  }
}

/** Short, human-readable label for a tool call — used in logs and live updates. */
function describeCall(name, args) {
  switch (name) {
    case "open_position":
      return `open_position ${String(args.pool ?? "").slice(0, 8)} ${args.deploy_sol ?? "auto"} SOL`;
    case "close_position":
      return `close_position ${String(args.position_mint ?? "").slice(0, 8)}`;
    case "harvest_fees":
      return `harvest_fees ${String(args.position_mint ?? "").slice(0, 8)}`;
    case "inspect_pool":
      return `inspect_pool ${String(args.pool ?? "").slice(0, 8)}`;
    case "get_token_info":
      return `get_token_info ${String(args.query ?? "").slice(0, 12)}`;
    case "update_config":
      return `update_config ${args.key}=${args.value}`;
    default:
      return name;
  }
}

/** Condense a tool result so the transcript stays inside a sane token budget. */
function summarizeResult(name, result) {
  if (result?.error) return { error: result.error, refused: !!result.refused };

  if (name === "get_candidates") {
    return {
      count: result.count,
      scanned: result.scanned,
      rejectedTotal: result.rejectedTotal,
      rejectedSample: result.rejectedSample,
      candidates: (result.candidates ?? []).map((pool) => ({
        pool: pool.address,
        pair: pool.pair,
        yieldScore: pool.yieldScore,
        rankScore: pool.rankScore,
        funding: pool.funding,
        tickSpacing: pool.tickSpacing,
        feeRatePct: pool.feeRatePct,
        feeAprPct: pool.feeApr != null ? Number((pool.feeApr * 100).toFixed(1)) : null,
        volumeTvlRatio: pool.volumeTvlRatio,
        tvlUsd: Math.round(pool.tvlUsd ?? 0),
        volume24hUsd: Math.round(pool.volume24h ?? 0),
        priceMove24hPct: pool.priceDelta24h != null ? Number((pool.priceDelta24h * 100).toFixed(1)) : null,
        lockedLiquidityPct: pool.lockedLiquidityPct,
        base: pool.baseSymbol,
        quote: pool.quoteSymbol,
        token: pool.token,
        history: pool.history,
      })),
    };
  }

  if (name === "get_positions") {
    return {
      count: result.count,
      maxPositions: result.maxPositions,
      positions: (result.positions ?? []).map((position) => ({
        index: position.index,
        positionMint: position.positionMint,
        pair: position.pair,
        status: position.status,
        rangeProgress: position.rangeProgress,
        pnlPct: position.pnlPct,
        // What the wallet would actually net if closed now — exits are judged on this.
        netPnlPct: position.netPnlPct ?? null,
        peakPnlPct: position.peakPnlPct,
        trailingActive: position.trailingActive,
        feesUsd: position.feesUsd,
        feeAprPct: position.feeApr != null ? Number((position.feeApr * 100).toFixed(1)) : null,
        valueUsd: position.valueUsd,
        minutesHeld: position.minutesHeld,
        rangeEfficiency: position.rangeEfficiency,
        widthPct: position.widthPct,
        poolFeeAprPct: position.poolFeeApr != null ? Number((position.poolFeeApr * 100).toFixed(1)) : null,
        note: position.note,
      })),
    };
  }

  return result;
}

function buildMessages({ systemPrompt, history, goal, embedSystem }) {
  if (embedSystem) {
    // Some providers reject role:"system" outright. Folding it into the user turn
    // costs a little adherence but keeps the agent usable on those endpoints.
    return [...history, { role: "user", content: `[INSTRUCTIONS]\n${systemPrompt}\n\n[TASK]\n${goal}` }];
  }
  return [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: goal }];
}

function isSystemRoleError(error) {
  return /invalid (message )?role|system role|unsupported role/i.test(String(error?.message ?? error));
}

/**
 * Run one agent turn.
 *
 * @param {object} params
 * @param {"SCREENER"|"MANAGER"|"CHAT"} params.role
 * @param {string} params.goal        the task or the operator's message
 * @param {object[]} [params.history] prior chat turns, for conversational use
 * @param {object} [params.balances]  pre-fetched balances, to avoid a duplicate RPC call
 * @param {(event: object) => void} [params.onStep] progress callback
 */
export async function runAgent({ role = "CHAT", goal, history = [], balances = null, extraPrompt = null, onStep = null }) {
  const model = modelFor(role);
  const tools = toolsForRole(role);
  const systemPrompt = await buildSystemPrompt(role, { balances, extra: extraPrompt });

  let embedSystem = false;
  let messages = buildMessages({ systemPrompt, history, goal, embedSystem });

  const calls = [];
  let report = null;
  let nudged = false;

  for (let step = 1; step <= config.llm.maxSteps; step += 1) {
    let completion;
    try {
      completion = await llm().chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: config.llm.temperature,
        max_tokens: config.llm.maxTokens,
      });
    } catch (err) {
      if (!embedSystem && isSystemRoleError(err)) {
        log("agent_warn", `${model} rejects the system role — retrying with it embedded in the user turn`);
        embedSystem = true;
        messages = buildMessages({ systemPrompt, history, goal, embedSystem });
        step -= 1;
        continue;
      }
      logError("agent", err);
      return {
        role,
        model,
        report: `Model call failed: ${err.message}`,
        calls,
        steps: step - 1,
        failed: true,
      };
    }

    const choice = completion.choices?.[0];
    const message = choice?.message;
    if (!message) {
      return { role, model, report: "Model returned no message.", calls, steps: step, failed: true };
    }

    messages.push(message);
    const toolCalls = message.tool_calls ?? [];
    const content = (message.content ?? "").trim();

    if (!toolCalls.length) {
      if (content) {
        report = content;
        break;
      }

      // Neither a tool call nor any text. Reasoning models are the usual cause:
      // the reasoning trace consumes the same completion budget as the reply, so
      // a long deliberation can leave nothing for the answer. Say exactly what
      // happened rather than recording a silent "(no report)".
      const usage = completion.usage ?? {};
      const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
      log(
        "agent_warn",
        `${model} ended the turn with no tool call and no text` +
          ` (finish_reason=${choice.finish_reason}` +
          `, completion_tokens=${usage.completion_tokens ?? "?"}` +
          (reasoningTokens != null ? `, of which reasoning=${reasoningTokens}` : "") +
          `, max_tokens=${config.llm.maxTokens})`,
      );

      if (nudged) {
        report =
          `${model} produced no final report` +
          (choice.finish_reason === "length"
            ? ` — it ran out of completion budget. Raise maxTokens (currently ${config.llm.maxTokens}); this model spends most of it on reasoning.`
            : ".");
        break;
      }

      // One explicit nudge. Cheap, and it recovers the cycle's reasoning instead
      // of throwing away a minute of work and several tool calls.
      nudged = true;
      messages.push({
        role: "user",
        content:
          "You returned an empty message. Reply now in plain prose: what did you check, what did you decide, and why. Do not call any tool.",
      });
      continue;
    }

    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      const label = describeCall(name, args);

      if (MUTATING_TOOLS.has(name)) log("agent", `→ ${label}`);
      onStep?.({ kind: "tool", step, name, label, args });

      const result = await executeTool(name, args);
      calls.push({ step, name, args, result, mutating: MUTATING_TOOLS.has(name) });
      onStep?.({ kind: "result", step, name, label, result });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(summarizeResult(name, result)).slice(0, 12_000),
      });
    }
  }

  if (report == null) {
    report = `Reached the ${config.llm.maxSteps}-step limit without a final report. ${calls.length} tool call${calls.length === 1 ? "" : "s"} were made.`;
  }

  // A screening or management turn that inspected nothing is not a decision, it is
  // a broken endpoint. This agent once ran 146 cycles over 19 hours recording an
  // upstream "quota exhausted" message as its reasoning, and raised no alarm —
  // silent failure in a monitoring run is worse than a loud stop.
  const inspected = calls.length > 0;
  const providerError = !inspected && role !== "CHAT" && looksLikeProviderError(report);
  if (!inspected && role !== "CHAT") {
    log(
      "agent_error",
      `${role} made no tool call at all — the model returned only text. ` +
        (providerError ? "This looks like an upstream API error, not a decision: " : "Reply was: ") +
        String(report).replace(/\s+/g, " ").slice(0, 200),
    );
  }

  const mutations = calls.filter((call) => call.mutating && !call.result?.error);
  log("agent", `${role} finished in ${calls.length} call${calls.length === 1 ? "" : "s"}${mutations.length ? ` (${mutations.length} action${mutations.length === 1 ? "" : "s"} taken)` : " (no action)"}`);

  return {
    role,
    model,
    report,
    calls,
    mutations,
    steps: calls.length,
    // `failed` means the cycle produced no usable work, not that an exception was
    // thrown — the caller needs to tell "decided to do nothing" from "never ran".
    failed: !inspected && role !== "CHAT",
    providerError,
  };
}

/**
 * Does this reply look like the provider complaining rather than the model
 * answering? Only consulted when the turn made no tool call at all, so ordinary
 * prose that happens to mention billing cannot trip it.
 */
export function looksLikeProviderError(text) {
  return /\b(quota|rate.?limit|exceeded|insufficient|billing|credits?|payment required|unauthor|invalid api key|forbidden)\b/i.test(
    String(text ?? ""),
  );
}
