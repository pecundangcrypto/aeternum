#!/usr/bin/env node
/**
 * Link a Telegram bot to this agent.
 *
 * Finding a chat id by hand means reading raw getUpdates JSON. This does it:
 * verifies the bot token in .env, finds the most recent private message sent to
 * the bot, and writes TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_IDS.
 *
 *   1. put TELEGRAM_BOT_TOKEN in .env
 *   2. send the bot any message from your own Telegram account
 *   3. node scripts/telegram-link.js            (shows what it found)
 *      node scripts/telegram-link.js --write    (saves it to .env)
 *
 * The token is never printed. The chat is taken only from a private chat, so a
 * stranger who finds the bot in a group cannot get themselves linked.
 */

import fs from "node:fs";
import { rootPath } from "../src/paths.js";

const ENV_PATH = rootPath(".env");
const write = process.argv.includes("--write");

function readEnv() {
  const values = {};
  if (!fs.existsSync(ENV_PATH)) return values;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

async function call(token, method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function setEnvValue(source, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(source) ? source.replace(pattern, line) : `${source.replace(/\n*$/, "\n")}${line}\n`;
}

const env = readEnv();
const token = env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not in .env yet. Create a bot with @BotFather and add the token first.");
  process.exit(1);
}

const me = await call(token, "getMe");
if (me.status === 401 || !me.payload?.ok) {
  console.error("Telegram rejected the token (401). Copy it again from @BotFather — no spaces, no quotes.");
  process.exit(1);
}
console.log(`Bot: @${me.payload.result.username} (${me.payload.result.first_name})`);

const updates = await call(token, "getUpdates", { timeout: 0, allowed_updates: ["message"] });
if (updates.status === 409) {
  console.error(
    "409 Conflict: something else is already reading this bot's updates — another running agent, " +
      "or a webhook. Stop the other process, or use a separate bot for Aeternum.",
  );
  process.exit(1);
}

const privateMessages = (updates.payload?.result ?? [])
  .map((update) => update.message)
  .filter((message) => message?.chat?.type === "private" && message.from && !message.from.is_bot);

if (!privateMessages.length) {
  console.error(`No private message found. Open @${me.payload.result.username} in Telegram, press Start or send "hi", then run this again.`);
  process.exit(1);
}

const latest = privateMessages[privateMessages.length - 1];
const chatId = String(latest.chat.id);
const userId = String(latest.from.id);
const who = latest.from.username ? `@${latest.from.username}` : latest.from.first_name;

console.log(`Latest private message from ${who}: "${String(latest.text ?? "").slice(0, 40)}"`);
console.log(`  chat id: ${chatId}`);
console.log(`  user id: ${userId}`);

if (!write) {
  console.log("\nIf that is you, run again with --write to save it to .env.");
  process.exit(0);
}

let source = fs.readFileSync(ENV_PATH, "utf8");
source = setEnvValue(source, "TELEGRAM_CHAT_ID", chatId);
source = setEnvValue(source, "TELEGRAM_ALLOWED_USER_IDS", userId);
fs.writeFileSync(ENV_PATH, source, { mode: 0o600 });

await call(token, "sendMessage", {
  chat_id: chatId,
  text: "Aeternum is linked to this chat. Commands start working once the agent is running — /help for the list.",
});
console.log("\nSaved to .env and sent a confirmation message to the chat.");
