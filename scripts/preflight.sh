#!/usr/bin/env bash
#
# Verify a run can actually work before leaving it alone for days.
# Checks model access, the Orca and Jupiter APIs, the local hivemind, and that no
# wallet key is present when paper mode is expected.
#
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
FAILED=0

echo "Preflight:"

# Paper mode is defined by the absence of a key, so check it explicitly.
if grep -qE '^WALLET_PRIVATE_KEY=.+' .env 2>/dev/null; then
  echo "  note  wallet key present — this run CAN sign transactions"
else
  pass "no wallet key — paper mode, cannot sign anything"
fi

if grep -qE '^DRY_RUN=true' .env 2>/dev/null; then pass "DRY_RUN=true"; else fail "DRY_RUN is not true in .env"; fi

# Model access: one real tool-calling round trip, which is what the agent needs.
if node -e '
import("./src/config.js").then(async ({ config }) => {
  if (!config.llm.apiKey) { console.error("no LLM API key configured"); process.exit(1); }
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ baseURL: config.llm.baseUrl, apiKey: config.llm.apiKey, timeout: 60000 });
  const r = await client.chat.completions.create({
    model: config.llm.screenModel,
    messages: [{ role: "user", content: "Call the ping tool with value 1." }],
    tools: [{ type: "function", function: { name: "ping", description: "test", parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } } }],
    tool_choice: "auto",
    max_tokens: 64,
  });
  const calls = r.choices?.[0]?.message?.tool_calls?.length ?? 0;
  if (!calls) {
    console.error(`${config.llm.baseUrl} served ${config.llm.screenModel} but it made no tool call — this agent cannot run without tool calling`);
    process.exit(1);
  }
  console.error(`${config.llm.screenModel} via ${config.llm.baseUrl} — tool calling works`);
}).catch((e) => { console.error(`${e.message}`); process.exit(1); });
' 2>/tmp/preflight-llm.txt; then pass "$(cat /tmp/preflight-llm.txt)"; else fail "model access: $(cat /tmp/preflight-llm.txt)"; fi

# Market data
if node bin/aeternum.js candidates --limit 1 >/tmp/preflight-cand.json 2>/dev/null \
   && node -e 'const d=require("/tmp/preflight-cand.json"); if(!d.scanned) process.exit(1)'; then
  pass "Orca + Jupiter reachable ($(node -e 'const d=require("/tmp/preflight-cand.json");process.stdout.write(String(d.scanned))') pools scanned)"
else
  fail "market data unreachable"
fi

# Hivemind, only if one is configured
HM=$(node -e 'process.stdout.write(String(require("./user-config.json").hivemindUrl||""))' 2>/dev/null)
if [ -n "$HM" ]; then
  if curl -fsS --max-time 5 "$HM/v1/health" >/dev/null 2>&1; then pass "hivemind reachable at $HM"
  else echo "  note  hivemind $HM not up yet — paper-run.sh starts it"; fi
fi

echo
[ "$FAILED" -eq 0 ] && echo "Ready. Start with: scripts/paper-run.sh start" || echo "Not ready — fix the failures above."
exit "$FAILED"
