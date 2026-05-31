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
import { resolve, basename, extname } from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

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

async function sendPhoto(chatId, filePath, caption) {
  try {
    const fileBuffer = readFileSync(filePath);
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const fileName = basename(filePath);

    // Build multipart body
    const encoder = new TextEncoder();
    const parts = [];

    // chat_id field
    parts.push(encoder.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
      `${chatId}\r\n`
    ));

    // photo field (file upload)
    parts.push(encoder.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="${fileName}"\r\n` +
      `Content-Type: ${imageMimeType(filePath)}\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(encoder.encode(`\r\n`));

    // caption field (optional)
    if (caption) {
      parts.push(encoder.encode(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n` +
        `${caption}\r\n`
      ));
    }

    // End boundary
    parts.push(encoder.encode(`--${boundary}--\r\n`));

    // Concatenate all parts
    const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const p of parts) {
      body.set(p, offset);
      offset += p.byteLength;
    }

    const res = await fetch(`${API_BASE}/sendPhoto`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": totalLength.toString(),
      },
      body: body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram API error (${res.status}): ${text}`);
    }
    return res.json();
  } catch (err) {
    console.error("❌ Failed to send photo:", err.message);
    // Fallback: send error message
    await sendMessage(chatId, `⚠️ Failed to send image: ${err.message}`);
  }
}

/** Image file extensions we can send to Telegram */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Get the MIME type for an image file based on its extension.
 */
function imageMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

/**
 * Extract image file paths from text.
 * Looks for paths ending in common image extensions that actually exist on disk.
 * Returns an array of { path, ext } objects.
 */
function extractImagePaths(text) {
  // Match anything that looks like a file path ending with an image extension.
  // This includes paths in backticks, quotes, or bare words.
  const imagePathRegex = /`([^`]+\.(?:png|jpg|jpeg|gif|webp))`|"([^"]+\.(?:png|jpg|jpeg|gif|webp))"|'([^']+\.(?:png|jpg|jpeg|gif|webp))'|([\w./\\-]+\.(?:png|jpg|jpeg|gif|webp))/gi;

  const found = [];
  const seen = new Set();
  let match;

  while ((match = imagePathRegex.exec(text)) !== null) {
    // Pick the first non-undefined capture group
    const rawPath = match[1] || match[2] || match[3] || match[4];
    if (!rawPath) continue;

    // Try to resolve relative to CWD
    const candidates = [
      rawPath,
      resolve(CWD, rawPath),
      resolve(CWD, basename(rawPath)),
    ];

    for (const candidate of candidates) {
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          const ext = extname(candidate).toLowerCase();
          if (IMAGE_EXTENSIONS.has(ext) && !seen.has(candidate)) {
            found.push({ path: candidate, ext });
            seen.add(candidate);
          }
          break; // Found a valid file, stop checking candidates
        }
      } catch {
        // Ignore errors (e.g., invalid paths)
      }
    }
  }

  return found;
}

/**
 * Send an "upload_photo" chat action so the user knows we're sending an image.
 */
async function sendUploadPhoto(chatId) {
  await tg("sendChatAction", {
    chat_id: chatId,
    action: "upload_photo",
  }).catch(() => {});
}

/**
 * Send a response that may contain both text and images.
 * If image paths are found in the text, they are sent as photos
 * and the remaining text is sent as a regular message.
 */
async function sendRichResponse(chatId, text) {
  if (!text) {
    await sendMessage(chatId, "✅ Done.");
    return;
  }

  const images = extractImagePaths(text);

  if (images.length === 0) {
    // No images — just send as text
    await sendMessage(chatId, text);
    return;
  }

  // We have images! Remove the image paths from the text for the caption.
  // Remove backtick-wrapped paths first, then bare paths
  let cleanText = text;
  for (const img of images) {
    // Remove backtick-wrapped version
    cleanText = cleanText.replace(new RegExp("`" + escapeRegex(img.path) + "`", "g"), "");
    cleanText = cleanText.replace(new RegExp("`" + escapeRegex(basename(img.path)) + "`", "g"), "");
    // Remove bare path version
    cleanText = cleanText.replace(new RegExp(escapeRegex(img.path), "g"), "");
    cleanText = cleanText.replace(new RegExp(escapeRegex(basename(img.path)), "g"), "");
  }
  // Clean up extra whitespace/newlines left after removal
  cleanText = cleanText.replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");

  // Send the first image with the clean text as caption, rest as separate photos
  await sendUploadPhoto(chatId);
  await sendPhoto(chatId, images[0].path, cleanText || undefined);

  for (let i = 1; i < images.length; i++) {
    await sendUploadPhoto(chatId);
    await sendPhoto(chatId, images[i].path);
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Shell Command Execution ─────────────────────────────────────────────────

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

async function processWithPi(message, options = {}) {
  if (!piSession) {
    return { text: "⚠️ pi is not initialized yet. Please wait and try again.", images: [] };
  }

  try {
    const parts = [];

    // Snapshot PNG files before pi runs
    const beforePngs = await collectPngFiles();

    const unsubscribe = piSession.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        parts.push(event.assistantMessageEvent.delta);
      }
    });

    // If we have images to send to pi, include them via prompt options
    const promptOptions = {};
    if (options.images && options.images.length > 0) {
      promptOptions.images = options.images;
    }

    await piSession.prompt(message, promptOptions);

    // Small delay to ensure all events are processed
    await new Promise((r) => setTimeout(r, 200));

    unsubscribe();

    const text = parts.join("") || "✅ Done.";

    // Find newly created PNG files by comparing before/after snapshots
    const afterPngs = await collectPngFiles();
    const newPngs = [];
    for (const f of afterPngs) {
      if (!beforePngs.has(f)) {
        newPngs.push(f);
      }
    }

    // Also find image paths mentioned in the response text
    const textImages = extractImagePaths(text).map((i) => i.path);

    // Combine: newly created files + paths found in text (deduplicated)
    const allImages = [...new Set([...newPngs, ...textImages])];

    return { text, images: allImages };
  } catch (err) {
    console.error("❌ pi processing error:", err.message);
    return { text: `⚠️ Error processing with pi: ${err.message}`, images: [] };
  }
}

/**
 * Execute a pi slash command directly via the session, without LLM processing.
 * Pi's internal commands (/model, /session, /settings, /skill:*, etc.) execute
 * immediately via extension command handlers and manage their own output.
 * @param {string} command - The full command text (e.g. "/model", "/session")
 * @returns {Promise<string>} - The command output text
 */
async function processPiCommand(command) {
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

    await piSession.prompt(command);

    // Small delay to ensure all events are processed
    await new Promise((r) => setTimeout(r, 200));

    unsubscribe();

    return parts.join("").trim() || "✅ Command completed.";
  } catch (err) {
    console.error("❌ pi command error:", err.message);
    return `⚠️ Error executing command: ${err.message}`;
  }
}

/**
 * Recursively collect all .png file paths in CWD.
 * @returns {Promise<Set<string>>}
 */
async function collectPngFiles() {
  const paths = new Set();
  try {
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");

    function walk(dir) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip node_modules and .git
          if (entry.name !== "node_modules" && entry.name !== ".git" && !entry.name.startsWith(".")) {
            walk(full);
          }
        } else if (entry.name.toLowerCase().endsWith(".png")) {
          paths.add(full);
        }
      }
    }

    walk(CWD);
  } catch {
    // If anything fails, return empty set
  }
  return paths;
}

/**
 * Download a file from Telegram by file_id and return its buffer.
 * @param {string} fileId
 * @returns {Promise<Buffer>}
 */
async function downloadTelegramFile(fileId) {
  const fileResp = await tg("getFile", { file_id: fileId });
  if (!fileResp.ok || !fileResp.result?.file_path) {
    throw new Error(`Failed to get file path: ${JSON.stringify(fileResp)}`);
  }
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileResp.result.file_path}`;
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
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
        if (msg.from?.is_bot) continue;

        const chatId = msg.chat.id;
        const fromName = msg.from?.first_name || "unknown";

        // Handle photo messages — download and send to pi for vision processing
        if (msg.photo) {
          const photoInfo = msg.photo[msg.photo.length - 1]; // highest resolution
          const caption = msg.caption || "What's in this image?";
          console.log(
            `\n📸 Photo from ${fromName} (chat ${chatId}): ${caption.slice(0, 100)}`,
          );

          sendTyping(chatId);

          try {
            // Download the photo from Telegram
            const photoBuffer = await downloadTelegramFile(photoInfo.file_id);
            const base64 = photoBuffer.toString("base64");

            // Send to pi with the image for vision analysis
            const { text, images: piCreatedImages } = await processWithPi(caption, {
              images: [{
                type: "image",
                source: {
                  type: "base64",
                  mediaType: "image/jpeg",
                  data: base64,
                },
              }],
            });

            // Send pi's text response
            const reply = text || "✅ Done.";
            await sendMessage(chatId, reply);

            // Send any images pi created
            for (const imgPath of piCreatedImages) {
              await sendUploadPhoto(chatId);
              await sendPhoto(chatId, imgPath);
            }

            console.log(`📤 Response sent to chat ${chatId}`);
          } catch (err) {
            console.error("❌ Photo processing error:", err.message);
            await sendMessage(chatId, `⚠️ Error processing photo: ${err.message}`);
          }
          continue;
        }

        // Skip non-text messages
        if (!msg.text) continue;

        const text = msg.text.trim();

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
            "`/<command>` — Any pi command (e.g. /model, /session, /settings, /skill:name)",
            "`!<command>` — Execute a shell command\n",
            "_Otherwise the message is sent to pi for AI processing._",
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

        // Handle all other pi slash commands — forward to piSession.prompt() directly.
        // Pi's internal commands (/model, /session, /settings, /skill:*, /compact,
        // /new, /fork, /tree, etc.) execute immediately without LLM, except /compact
        // which internally uses the LLM (the documented exception).
        if (text.startsWith("/")) {
          console.log(`🎯 Pi command: ${text}`);
          sendTyping(chatId);
          const output = await processPiCommand(text);
          await sendMessage(chatId, output);
          console.log(`📤 Pi command response sent to chat ${chatId}`);
          continue;
        }

        // Handle shell commands — messages starting with !
        if (text.startsWith("!")) {
          const shellCmd = text.slice(1).trim();
          console.log(`🐚 Shell command: ${shellCmd}`);
          sendTyping(chatId);

          // Safety: allow only safe commands? No — the user has shell access already.
          // Just execute and return output.
          // We default to a 30s timeout to prevent runaway commands.
          try {
            const output = execSync(shellCmd, {
              cwd: CWD,
              timeout: 30_000,
              encoding: "utf-8",
              maxBuffer: 10 * 1024 * 1024, // 10MB
              stdio: ["ignore", "pipe", "pipe"],
            });
            const stdout = output?.trim() || "";
            if (stdout) {
              await sendMessage(chatId, stdout);
            } else {
              // If stdout is empty, send stderr (or a done message)
              await sendMessage(chatId, "✅ Command completed (no output).");
            }
          } catch (err) {
            const errorMsg = err.stderr?.toString().trim() || err.message;
            const stdout = err.stdout?.toString().trim();
            let reply = `❌ Command failed:\n\`\`\`\n${errorMsg}\n\`\`\``;
            if (stdout) {
              reply += `\n\n*stdout:*\n\`\`\`\n${stdout.slice(0, 3500)}\n\`\`\``;
            }
            await sendMessage(chatId, reply);
          }
          console.log(`🐚 Shell command completed for chat ${chatId}`);
          continue;
        }

        // Send typing indicator
        sendTyping(chatId);

        // Process with pi
        const { text: response, images: createdImages } = await processWithPi(text);

        // Send response text — auto-detect image paths mentioned in text
        const reply = response || "✅ Done.";
        await sendRichResponse(chatId, reply);

        // Send any newly created images pi generated (not already sent by sendRichResponse)
        for (const imgPath of createdImages) {
          // skip if already handled by sendRichResponse (path was in text)
          if (reply.includes(imgPath) || reply.includes(basename(imgPath))) continue;
          await sendUploadPhoto(chatId);
          await sendPhoto(chatId, imgPath, "📸 Here's the image I created:");
        }

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
