#!/usr/bin/env node

/**
 * pi-telegram-connector
 *
 * A Telegram <-> pi-coding-agent bridge.
 *
 * Polls Telegram for incoming messages, sends them to pi via the SDK,
 * and relays pi's responses back to the Telegram chat.
 *
 * Usage:
 *   1. Create a bot: talk to @BotFather on Telegram, get a token
 *   2. Set env: export TELEGRAM_BOT_TOKEN="your:token_here"
 *   3. Run:   node index.mjs [--cwd /path/to/project]
 *   4. Message your bot on Telegram — pi will respond!
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

// ─── Config ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CWD = resolve(process.argv.find((a) => a.startsWith("--cwd="))?.slice(6) || process.cwd());
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN environment variable is not set.");
  console.error("   Talk to @BotFather on Telegram to create a bot and get a token.");
  process.exit(1);
}

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {import("@earendil-works/pi-coding-agent").AgentSession | null} */
let piSession = null;
let lastUpdateId = 0;

// ─── Telegram Helpers ────────────────────────────────────────────────────────

async function tg(method, body) {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram API error (${res.status}): ${text}`);
  }
  return res.json();
}

async function getUpdates() {
  const resp = await tg("getUpdates", {
    offset: lastUpdateId + 1,
    timeout: 30,
    allowed_updates: ["message"],
  });
  if (!resp.ok) return [];
  return resp.result || [];
}

async function sendMessage(chatId, text) {
  // Split long messages (Telegram limit: 4096 chars)
  const maxLen = 4000;
  for (let i = 0; i < text.length; i += maxLen) {
    const chunk = text.slice(i, i + maxLen);
    await tg("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    });
  }
}

async function sendTyping(chatId) {
  await tg("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  }).catch(() => {});
}

// ─── Pi Session ──────────────────────────────────────────────────────────────

async function initPiSession() {
  console.log("🤖 Initializing pi-coding-agent session in:", CWD);
  try {
    const { session } = await createAgentSession({ cwd: CWD });
    piSession = session;
    console.log("✅ pi-coding-agent session ready.");
    return session;
  } catch (err) {
    console.error("❌ Failed to initialize pi session:", err);
    throw err;
  }
}

async function processWithPi(message) {
  if (!piSession) {
    return "⚠️ pi is not initialized yet. Please wait and try again.";
  }

  try {
    const parts = [];

    const unsubscribe = piSession.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        parts.push(event.assistantMessageEvent.delta);
      }
    });

    await piSession.prompt(message);

    // Small delay to ensure all events are processed
    await new Promise((r) => setTimeout(r, 100));

    unsubscribe();

    return parts.join("") || "✅ Done.";
  } catch (err) {
    console.error("❌ pi processing error:", err.message);
    return `⚠️ Error processing with pi: ${err.message}`;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   🤖 pi Telegram Connector                   ║");
  console.log("║   Chat with pi-coding-agent via Telegram      ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`   CWD: ${CWD}`);
  console.log();

  // Verify bot token
  try {
    const me = await tg("getMe");
    console.log(`✅ Connected as @${me.result.username}`);
    console.log("📩 Send a message to your bot — pi will reply!\n");
  } catch (err) {
    console.error("❌ Failed to verify bot token:", err.message);
    process.exit(1);
  }

  // Initialize pi session
  await initPiSession();

  // Poll loop
  console.log("👂 Polling for messages...\n");

  while (true) {
    try {
      const updates = await getUpdates();

      for (const update of updates) {
        lastUpdateId = update.update_id;

        const msg = update.message;
        if (!msg) continue;

        // Skip non-text messages and bot's own messages
        if (!msg.text) continue;
        if (msg.from?.is_bot) continue;

        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const fromName = msg.from?.first_name || "unknown";

        console.log(
          `\n📨 Telegram message from ${fromName} (chat ${chatId}): ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`,
        );

        // Handle /start command
        if (text === "/start") {
          const welcome = [
            "👋 *Welcome to pi — your coding agent!*\n",
            "I'm pi, an AI coding assistant that can help you with your projects.\n",
            "Here's what I can do:",
            "• 💻 Read and edit code files",
            "• 🛠️ Run commands and scripts",
            "• 📝 Answer coding questions",
            "• 🔍 Debug issues",
            "• 📖 Explain code",
            "\n_Send me any coding question or task, and I'll help you out!_\n",
            "---",
            "`/help` — Show this message",
            "`/status` — Check connection status",
            "`/new` — Start a fresh conversation (reset context)",
            "`/compact` — Compact conversation history for pi",
          ].join("\n");
          await sendMessage(chatId, welcome);
          console.log(`📤 Welcome message sent to chat ${chatId}`);
          continue;
        }

        // Handle /help command
        if (text === "/help") {
          const help = [
            "📚 *pi Telegram Commands*\n",
            "`/start` — Start the bot and see welcome message",
            "`/help` — Show this help message",
            "`/status` — Check connection status",
            "`/new` — Start a fresh conversation (reset context)",
            "`/compact` — Compact conversation history for pi\n",
            "_Any other message will be sent to pi for processing._",
          ].join("\n");
          await sendMessage(chatId, help);
          continue;
        }

        // Handle /status command
        if (text === "/status") {
          const status = piSession
            ? "✅ pi session is *active* and ready."
            : "❌ pi session is *not initialized*.";
          await sendMessage(chatId, status);
          continue;
        }

        // Handle /compact command — summarize conversation and reset session
        if (text === "/compact") {
          if (!piSession) {
            await sendMessage(chatId, "⚠️ No active session to compact.");
            continue;
          }
          await sendMessage(chatId, "🧹 Compacting conversation history...");
          sendTyping(chatId);

          // Ask pi to summarize the conversation so far
          const summary = await processWithPi(
            "Please provide a concise summary of our entire conversation so far, " +
            "capturing all key information, decisions, code changes, and context. " +
            "This summary will be used to restore context after a session reset."
          );

          // Reset the session
          if (piSession) {
            piSession.dispose();
            piSession = null;
          }
          await initPiSession();

          // Feed the summary back as the new context
          sendTyping(chatId);
          await piSession.prompt(
            "[Previous conversation summary — this is a compacted restoration of " +
            "the prior context]\n\n" + summary
          );

          await sendMessage(chatId,
            "✅ Conversation compacted! The summary has been loaded as context.\n\n" +
            "*Summary:*\n" + summary
          );
          console.log(`🧹 Conversation compacted for chat ${chatId}`);
          continue;
        }

        // Handle /new command — reset pi session
        if (text === "/new") {
          await sendMessage(chatId, "🔄 Resetting pi session...");
          if (piSession) {
            piSession.dispose();
            piSession = null;
          }
          try {
            await initPiSession();
            await sendMessage(chatId, "✅ Session reset! You're starting fresh.");
          } catch (err) {
            await sendMessage(chatId, `⚠️ Failed to reset session: ${err.message}`);
          }
          console.log(`🔄 Session reset for chat ${chatId}`);
          continue;
        }

        // Send typing indicator
        sendTyping(chatId);

        // Process with pi
        const response = await processWithPi(text);

        // Send response back — always send a message on completion
        const reply = response || "✅ Done.";
        await sendMessage(chatId, reply);
        console.log(
          `📤 Response sent to chat ${chatId}: ${reply.slice(0, 100)}${reply.length > 100 ? "..." : ""}`,
        );
      }
    } catch (err) {
      // Don't crash on transient errors — just log and retry
      console.error("⚠️ Poll error:", err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down...");
  if (piSession) piSession.dispose();
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (piSession) piSession.dispose();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
