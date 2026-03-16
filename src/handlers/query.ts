import { unlinkSync } from "fs";

import { InputFile, type Bot } from "grammy";

import { TEMP_DIR } from "../config";
import { type EngineAdapter, type EngineImageInput, type ToolCategory, type UsageEvent } from "../engine/interface";
import { calculateCost, getContextWindow } from "../engine/pricing";
import { handleContextWarning } from "../session/context-monitor";
import { consumeInterruptFlag } from "../session/lifecycle";
import { SessionStore } from "../session/store";
import { type ImageData, type Session } from "../types";
import { sendFilesToUser } from "../util/files";
import { markdownToTelegramHTML, stripMarkdown } from "../util/markdown";
import { sendLongMessageDirect } from "../util/telegram";
import { synthesizeSpeech, type TTSRouterConfig } from "../voice/tts-router";

const STATUS_THROTTLE_MS = 500;

function categoryIcon(category: ToolCategory): string {
  switch (category) {
    case "bash":
      return "⚡";
    case "read":
      return "📖";
    case "write":
      return "✏️";
    case "search":
      return "🔍";
    case "agent":
      return "🤖";
    case "mcp":
      return "🧩";
    default:
      return "🔧";
  }
}

function truncate(text: string, max = 80): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function formatToolStatus(name: string, category: ToolCategory, preview: string): string {
  const lines = preview.split("\n").filter(Boolean);

  if (category === "bash") {
    // Preview format from Codex: "Command:\n<actual command>"
    // Take the command line (lines[1]), or strip "Command:" prefix from lines[0]
    const cmd = lines.length > 1
      ? lines.slice(1).join(" ")
      : (lines[0] || "").replace(/^Command:\s*/i, "") || name;
    return `bash\n  ${truncate(cmd, 200)}`;
  }

  if (category === "write") {
    const detail = lines.length > 1
      ? lines.slice(1).join(" ")
      : (lines[0] || "").replace(/^Files:\s*/i, "") || name;
    return `${name}\n  ${truncate(detail, 200)}`;
  }

  if (category === "read") {
    const path = (lines[0] || "").replace(/^File:\s*/i, "") || name;
    return `${name}\n  ${truncate(path, 200)}`;
  }

  if (category === "agent") {
    return `Spawning agent...`;
  }

  // Default: show name + full preview
  const detail = lines.join(" ") || name;
  return `${name}\n  ${truncate(detail, 200)}`;
}

function mimeTypeToExtension(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

async function prepareEngineImages(userId: number, images: ImageData[]): Promise<{
  engineImages: EngineImageInput[];
  tempPaths: string[];
}> {
  const tempPaths: string[] = [];
  const engineImages: EngineImageInput[] = [];
  const stamp = Date.now();

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (!image) continue;

    const extension = mimeTypeToExtension(image.mimeType);
    const filePath = `${TEMP_DIR}/img_${userId}_${stamp}_${index}.${extension}`;
    await Bun.write(filePath, image.buffer);

    tempPaths.push(filePath);
    engineImages.push({
      filePath,
      mimeType: image.mimeType,
      base64Data: image.buffer.toString("base64"),
    });
  }

  return { engineImages, tempPaths };
}

function cleanupTempFiles(paths: string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
}

function buildTaskNotification(taskId: string, status: "completed" | "failed" | "stopped" | "started", summary?: string): string {
  const shortTaskId = taskId.slice(0, 8);

  if (status === "completed") {
    const preview = summary ? `\n${truncate(summary, 500)}` : "";
    return `Background task completed (${shortTaskId}).${preview}`;
  }

  if (status === "failed") {
    const preview = summary ? `\n${truncate(summary, 300)}` : "";
    return `Background task failed (${shortTaskId}).${preview}`;
  }

  if (status === "started") {
    return `Background task started (${shortTaskId}).`;
  }

  return `Background task stopped (${shortTaskId}).`;
}

function updateUsageInSession(
  event: UsageEvent,
  session: Session,
  fallbackModel: string
): UsageEvent {
  const model = event.model ?? fallbackModel;
  const contextWindow = event.contextWindowSize ?? getContextWindow(model);
  const costUSD =
    event.costUSD ??
    calculateCost(model, {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cachedInputTokens: event.cachedInputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
    });

  if (typeof costUSD === "number" && Number.isFinite(costUSD)) {
    session.totalCostUSD += costUSD;
  }

  // Context fill = input_tokens + cache_read + cache_creation (all three additive).
  // Claude API: input_tokens is ONLY non-cached tokens (after last cache breakpoint).
  // cache_read = tokens served from cache, cache_creation = tokens written to cache.
  // All three occupy context window space. Ref: Anthropic prompt caching docs,
  // SDK bS1() in cli.js: input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
  // Codex: input_tokens is a billing sum across API calls, not context size — but we store
  // the same way for consistency; context-monitor skips Codex context % anyway.
  const totalContextTokens = event.inputTokens + event.cachedInputTokens + event.cacheCreationInputTokens;
  session.lastInputTokens = totalContextTokens;
  // Use latest value, don't accumulate — each turn reports the full context snapshot.
  session.cumulativeInputTokens = totalContextTokens;

  session.lastModelUsage = {
    [model]: {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadInputTokens: event.cachedInputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      contextWindow,
      costUSD: typeof costUSD === "number" && Number.isFinite(costUSD) ? costUSD : 0,
    },
  };

  return {
    ...event,
    model,
    contextWindowSize: contextWindow,
    costUSD,
  };
}

const NOISE_PATTERNS = [
  /vault\.sh/i,
  /vault\s+get/i,
  /sops\s/i,
  /resolving\s+path/i,
  /retrying/i,
  /\.gnupg/i,
  /keyring/i,
  /age-keygen/i,
];

function isInternalNoise(text: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface ProcessQueryOptions {
  adapter: EngineAdapter;
  session: Session;
  prompt: string;
  userId: number;
  chatId: number;
  bot: Bot;
  store: SessionStore;
  workingDir: string;
  ttsConfig: TTSRouterConfig;
  statusMsgId?: number;
  model?: string;
  images?: ImageData[];
}

export async function processQuery(options: ProcessQueryOptions): Promise<void> {
  const {
    adapter,
    session,
    prompt,
    userId,
    chatId,
    bot,
    store,
    workingDir,
    ttsConfig,
    statusMsgId,
    model,
    images,
  } = options;

  const abortController = new AbortController();
  session.abortController = abortController;
  session.isQueryActive = true;
  session.chatId = chatId;

  store.set(userId, session);

  let lastStatusUpdate = 0;
  let currentStatus = "⏳ Processing...";
  let statusCleared = false;
  let lastEventTime = Date.now();
  const HEARTBEAT_INTERVAL_MS = 8_000;
  const HEARTBEAT_IDLE_THRESHOLD_MS = 10_000;

  const heartbeatInterval = setInterval(async () => {
    if (statusCleared) return;
    if (Date.now() - lastEventTime > HEARTBEAT_IDLE_THRESHOLD_MS) {
      try {
        await bot.api.sendChatAction(chatId, "typing");
      } catch {
        // best-effort heartbeat
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const clearStatus = async (): Promise<void> => {
    if (!statusMsgId || statusCleared) return;

    statusCleared = true;
    try {
      await bot.api.deleteMessage(chatId, statusMsgId);
    } catch {
      // ignore missing/deleted status message
    }
  };

  const updateStatus = async (newStatus: string): Promise<void> => {
    if (!statusMsgId || statusCleared) return;

    const now = Date.now();
    if (newStatus === currentStatus || now - lastStatusUpdate < STATUS_THROTTLE_MS) {
      return;
    }

    currentStatus = newStatus;
    lastStatusUpdate = now;

    try {
      await bot.api.editMessageText(chatId, statusMsgId, newStatus);
    } catch {
      // status updates are best effort
    }
  };

  let streamedRawText = "";
  let textDone = "";
  let previousTextDone = "";
  let doneText = "";
  const sentChunks: string[] = [];
  const tempImagePaths: string[] = [];
  const emptyPreparedImages: { engineImages: EngineImageInput[]; tempPaths: string[] } = {
    engineImages: [],
    tempPaths: [],
  };

  try {
    const { engineImages, tempPaths } = images?.length
      ? await prepareEngineImages(userId, images)
      : emptyPreparedImages;
    tempImagePaths.push(...tempPaths);

    const queryConfig = {
      prompt,
      images: engineImages.length > 0 ? engineImages : undefined,
      sessionId: session.sessionId,
      workingDir,
      abortSignal: abortController.signal,
      model,
      reasoningEffort: session.reasoningEffort,
    };

    for await (const event of adapter.query(queryConfig)) {
      lastEventTime = Date.now();
      const committedSessionId = adapter.getSessionId();

      if (committedSessionId && committedSessionId !== session.sessionId) {
        session.sessionId = committedSessionId;
      }

      if (event.type === "session.started") {
        continue;
      }

      if (event.type === "text.delta") {
        streamedRawText += event.text;
        await updateStatus("✍️ Writing response...");

        const formattedChunk = markdownToTelegramHTML(event.text).trim();
        if (!formattedChunk) {
          continue;
        }

        if (/\[SEND_FILE:[^\]]+\]/.test(event.text)) {
          continue;
        }

        await sendLongMessageDirect(bot, chatId, formattedChunk, 4000, "HTML");
        sentChunks.push(formattedChunk);
        continue;
      }

      if (event.type === "text.done") {
        textDone = event.text;
        // Codex emits text.done per agent_message with accumulated text — no text.delta events.
        // Claude emits text.delta during streaming AND text.done at the end.
        // Only send text.done delta when nothing was sent via text.delta (Codex path).
        if (sentChunks.length === 0) {
          const delta = event.text.slice(previousTextDone.length).trim();
          previousTextDone = event.text;

          if (delta && !/\[SEND_FILE:[^\]]+\]/.test(delta)) {
            const formatted = markdownToTelegramHTML(delta).trim();
            if (formatted) {
              await sendLongMessageDirect(bot, chatId, formatted, 4000, "HTML");
              sentChunks.push(formatted);
            }
          }
        }
        continue;
      }

      if (event.type === "tool.started") {
        if (isInternalNoise(event.preview) || isInternalNoise(event.toolName)) {
          continue;
        }
        const icon = categoryIcon(event.toolCategory);
        const statusLine = formatToolStatus(event.toolName, event.toolCategory, event.preview);
        await updateStatus(`${icon} ${statusLine}`);
        continue;
      }

      if (event.type === "tool.updated") {
        if (event.output && isInternalNoise(event.output)) {
          continue;
        }
        await updateStatus(`🔄 ${truncate(event.output || event.toolName, 120)}`);
        continue;
      }

      if (event.type === "tool.completed") {
        await updateStatus("🔄 Processing result...");
        continue;
      }

      if (event.type === "usage") {
        updateUsageInSession(event, session, model ?? `${adapter.name}-unknown`);
        continue;
      }

      if (event.type === "context.warning") {
        await handleContextWarning(event, session, store, chatId, bot);
        continue;
      }

      if (event.type === "task.notification") {
        const taskMessage = buildTaskNotification(event.taskId, event.status, event.summary);
        await bot.api.sendMessage(chatId, taskMessage);
        continue;
      }

      if (event.type === "error") {
        if (event.fatal) {
          throw new Error(event.message);
        }

        await bot.api.sendMessage(chatId, event.message);
        continue;
      }

      if (event.type === "reasoning") {
        if (session.showThinking && event.text) {
          const thinkingText = truncate(event.text, 500);
          try {
            await bot.api.sendMessage(chatId, `💭 ${thinkingText}`);
          } catch {
            // best-effort thinking display
          }
        }
        continue;
      }

      if (event.type === "done") {
        doneText = event.fullText;
      }
    }

    await clearStatus();

    const rawFinalText = textDone || doneText || streamedRawText;
    const { cleanedText, fileNotifications } = await sendFilesToUser(bot, chatId, rawFinalText);
    const finalText = markdownToTelegramHTML(cleanedText).trim();

    if (sentChunks.length === 0) {
      if (finalText) {
        await sendLongMessageDirect(bot, chatId, finalText, 4000, "HTML");
      } else {
        await bot.api.sendMessage(chatId, "(No text response from engine)");
      }
    } else if (fileNotifications.length > 0) {
      await sendLongMessageDirect(bot, chatId, fileNotifications.join("\n"), 4000, "HTML");
    }

    if (session.voiceMode !== "off" && finalText) {
      try {
        const ttsText = stripMarkdown(cleanedText).trim();
        const audioBuffers = await synthesizeSpeech(ttsText, session.voiceMode, ttsConfig);
        for (const buffer of audioBuffers) {
          await bot.api.sendVoice(chatId, new InputFile(buffer, "voice.ogg"));
        }
      } catch (error) {
        console.error("TTS send error:", error);
      }
    }
  } catch (error) {
    await clearStatus();

    const errorText = String(error).toLowerCase();
    if (errorText.includes("abort") || errorText.includes("cancel") || errorText.includes("interrupt")) {
      const wasInterrupt = consumeInterruptFlag(session);
      if (!wasInterrupt && !session.isResetting) {
        await bot.api.sendMessage(chatId, "🛑 Query stopped.");
      }
    } else {
      const errorLower = String(error).toLowerCase();
      if (
        errorLower.includes("no conversation found") ||
        (errorLower.includes("session") && errorLower.includes("not found"))
      ) {
        session.sessionId = undefined;
        store.set(userId, session);
        await store.save();
        await bot.api.sendMessage(chatId, "Session expired. Send a new message to start fresh.");
      } else {
        console.error("Query error:", error);
        const message = error instanceof Error ? error.message : String(error);
        await bot.api.sendMessage(chatId, `Error: ${message}`);
      }
    }
  } finally {
    clearInterval(heartbeatInterval);
    cleanupTempFiles(tempImagePaths);

    session.lastActivity = Date.now();
    session.abortController = undefined;
    session.isQueryActive = false;

    store.set(userId, session);
    await store.save();
  }
}
