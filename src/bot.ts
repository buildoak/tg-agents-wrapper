import { Bot, InlineKeyboard } from "grammy";

import { BufferManager } from "./buffer/message-buffer";
import { MediaGroupCollector } from "./buffer/media-group";
import { BOT_NAME, DEFAULT_ENGINE, isAuthorized, WET_DISABLED } from "./config";
import { type EngineAdapter } from "./engine/interface";
import { getSessionTokens, resetSessionTokens } from "./engine/session-tokens";
import { stopJsonlWatcher } from "./engine/jsonl-watcher";
import { handleCallbackQuery } from "./handlers/callback";
import { handleDocumentMessage } from "./handlers/document";
import { handlePhotoMessage } from "./handlers/photo";
import { handleTextMessage } from "./handlers/text";
import { handleVoiceMessage } from "./handlers/voice";
import { abortUserQuery } from "./session/lifecycle";
import { SessionStore } from "./session/store";
import {
  CODEX_MODELS,
  isCodexModel,
  isReasoningEffort,
  REASONING_EFFORTS,
  type EngineType,
  type Session,
} from "./types";
import { getWetStatus, isWetAvailable, killWetProcess, restartWetServe } from "./integrations/wet";
import { type OpenAITranscriptionClient } from "./voice/transcribe";
import { type TTSRouterConfig } from "./voice/tts-router";

/** Map internal effort name to what the API actually receives */
function displayEffort(effort?: string): string {
  switch (effort) {
    case "xhigh": return "max";
    case "minimal": return "low";
    default: return effort || "high";
  }
}

export interface CreateBotDeps {
  token: string;
  store: SessionStore;
  engines: Record<EngineType, EngineAdapter>;
  openaiClient?: OpenAITranscriptionClient | null;
  workingDir: string;
  documentFilesDir: string;
  ttsConfig: TTSRouterConfig;
}

export interface CreatedBot {
  bot: Bot;
  bufferManager: BufferManager;
  mediaGroupCollector: MediaGroupCollector;
}

export const BOT_COMMANDS = [
  { command: "start", description: "Start or reset the session" },
  { command: "stop", description: "Stop the current session" },
  { command: "interrupt", description: "Abort the current query" },
  { command: "status", description: "Show session status" },
  { command: "context", description: "Show context usage" },
  { command: "mode", description: "Change voice mode" },
  { command: "voice", description: "Set the voice ID" },
  { command: "batch", description: "Toggle batch delay" },
  { command: "engine", description: "Switch engine" },
  { command: "model", description: "Switch Codex model" },
  { command: "effort", description: "Switch reasoning effort" },
  { command: "thinking", description: "Toggle thinking visibility" },
] satisfies Array<{ command: string; description: string }>;

function modeLabel(mode: Session["voiceMode"]): string {
  if (mode === "cloud") return "🎙️ Voice (Cloud)";
  if (mode === "local") return "🖥️ Voice Local";
  return "📝 Normal";
}

function modeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Normal", "mode:normal")
    .text("Voice", "mode:cloud")
    .text("Voice Local", "mode:local");
}

async function formatWetStats(): Promise<string | null> {
  if (!isWetAvailable()) return null;

  const status = await getWetStatus();
  if (!status) return null;

  const ratio = status.items_total > 0
    ? `${status.items_compressed}/${status.items_total}`
    : "0/0";
  const savedK = status.tokens_saved >= 1000
    ? `${(status.tokens_saved / 1000).toFixed(1)}k`
    : String(status.tokens_saved);
  const pauseTag = status.paused ? " (paused)" : "";

  return [
    "",
    `<b>Wet Proxy</b>${pauseTag}`,
    `Compressed: ${ratio} items`,
    `Tokens saved: ${savedK}`,
    `Mode: ${status.mode}`,
  ].join("\n");
}

function parseCommandArg(text: string, command: string): string {
  return text.replace(new RegExp(`^/${command}(?:@\\w+)?\\s*`), "").trim();
}

function getAdapter(engines: Record<EngineType, EngineAdapter>, engine: EngineType): EngineAdapter {
  return engines[engine] ?? engines.claude;
}

function resetQueryState(session: Session): void {
  session.sessionId = undefined;
  session.lastInputTokens = 0;
  session.cumulativeInputTokens = 0;
  session.lastModelUsage = undefined;
}

export function createBot(deps: CreateBotDeps): CreatedBot {
  const bot = new Bot(deps.token);
  bot.catch((error) => {
    console.error("Bot handler error:", error.error);
  });

  const bufferManager = new BufferManager({
    bot,
    store: deps.store,
    getAdapter: (engine) => getAdapter(deps.engines, engine),
    workingDir: deps.workingDir,
    ttsConfig: deps.ttsConfig,
  });

  const mediaGroupCollector = new MediaGroupCollector({
    onGroupReady: async ({ images, caption, chatId, userId }) => {
      const session = deps.store.get(userId);
      const imagePrompt = caption || `What's in ${images.length > 1 ? "these images" : "this image"}?`;

      const statusMsg = await bot.api.sendMessage(
        chatId,
        `📨 Queued ${images.length} image${images.length > 1 ? "s" : ""}...`
      );

      bufferManager.bufferMessage(
        userId,
        chatId,
        {
          telegramMessageId: 0, // synthetic, no single source message
          userId,
          chatId,
          text: imagePrompt,
          type: "photo",
          images,
          media: { hasVoice: false, hasPhoto: true, hasDocument: false, hasMediaGroup: true },
          timestamps: {
            telegramDateUnix: Math.floor(Date.now() / 1000),
            receivedAtUnix: Date.now(),
          },
          voiceMode: session.voiceMode,
          statusMsgId: statusMsg.message_id,
        },
        session
      );
    },
    debounceMs: 500,
  });

  bufferManager.setMediaGroupCollector(mediaGroupCollector);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !isAuthorized(userId)) {
      await ctx.reply(`Unauthorized. Your user ID: ${userId}`);
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const existing = deps.store.getAll().get(userId);
    const previousEngine = existing?.engine;
    const previousEffort = existing?.reasoningEffort;
    const previousCodexModel = existing?.codexModel;

    if (existing) {
      const adapter = getAdapter(deps.engines, existing.engine);
      await abortUserQuery(userId, adapter, deps.store);
      if (adapter.disposeSession) {
        await adapter.disposeSession(String(userId));
      }
    }

    await bufferManager.clearUserBuffers(userId);
    deps.store.delete(userId);

    // Preserve engine and effort choices across /start
    const fresh = deps.store.get(userId);
    if (previousEngine) {
      fresh.engine = previousEngine;
      if (previousEffort) fresh.reasoningEffort = previousEffort;
    }
    if (previousCodexModel) {
      fresh.codexModel = previousCodexModel;
    }
    // Reset wet context tracking for the new session
    fresh.wetContextTokens = 0;
    fresh.wetContextWindow = 0;
    deps.store.set(userId, fresh);

    await deps.store.save();

    // Reset dual-lane token tracking and stop JSONL watcher
    if (WET_DISABLED) {
      resetSessionTokens();
      stopJsonlWatcher();
    } else {
      // Restart wet proxy so the new session gets a clean context tracker
      await restartWetServe();
    }

    await ctx.reply(`${BOT_NAME} online. New session (${previousEngine || DEFAULT_ENGINE}).  Choose your mode:`, {
      reply_markup: modeKeyboard(),
    });
  });

  bot.command("stop", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const existing = deps.store.getAll().get(userId);
    if (existing) {
      const adapter = getAdapter(deps.engines, existing.engine);
      await abortUserQuery(userId, adapter, deps.store);
      if (adapter.disposeSession) {
        await adapter.disposeSession(String(userId));
      }
    }

    await bufferManager.clearUserBuffers(userId);
    deps.store.delete(userId);
    await deps.store.save();

    // Clean up context tracking
    if (WET_DISABLED) {
      resetSessionTokens();
      stopJsonlWatcher();
    } else {
      // Kill wet proxy — it tracks context per session, stale after /stop
      killWetProcess();
    }

    await ctx.reply("Session stopped. Any running query was aborted.");
  });

  bot.command("interrupt", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = deps.store.getAll().get(userId);
    const hadQuery = Boolean(session?.isQueryActive || session?.abortController);
    const hadBuffer = bufferManager.has(userId);

    if (hadQuery && session) {
      await abortUserQuery(userId, getAdapter(deps.engines, session.engine), deps.store, true);
    }

    if (hadBuffer) {
      await bufferManager.clearUserBuffers(userId);
    }

    if (hadQuery || hadBuffer) {
      await ctx.reply("Interrupted. Session preserved.");
    } else {
      await ctx.reply("Nothing running to interrupt.");
    }
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = deps.store.getAll().get(userId);
    let status = "";

    if (session?.sessionId) {
      const idleSeconds = Math.floor((Date.now() - session.lastActivity) / 1000);
      status = `Session active\nID: ${session.sessionId.slice(0, 8)}...\nIdle: ${idleSeconds}s`;
    } else if (session?.isQueryActive) {
      status = "Session active\nID: initializing...";
    } else {
      status = "No active session.";
    }

    if (session) {
      status += `\nEngine: ${session.engine}`;
      status += `\nCodex model: ${session.codexModel}`;
      status += `\nEffort: ${displayEffort(session.reasoningEffort)}`;
      status += `\nMode: ${modeLabel(session.voiceMode)}`;
      status += `\nBatch delay: ${Math.round(session.batchDelayMs / 1000)}s`;
    }

    status += `\nVoice transcription: ${deps.openaiClient ? "✅ enabled" : "❌ disabled"}`;

    await ctx.reply(status);
  });

  bot.command("context", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = deps.store.getAll().get(userId);
    const wetStats = await formatWetStats();

    if (!session?.sessionId) {
      if (wetStats) {
        await ctx.reply(`No active session.${wetStats}`, { parse_mode: "HTML" });
      } else {
        await ctx.reply("No active session. Send a message first.");
      }
      return;
    }

    if (session.engine !== "claude") {
      const usage = session.lastModelUsage ? Object.values(session.lastModelUsage)[0] : null;
      if (!usage) {
        const msg = wetStats
          ? `No context data yet for current engine.${wetStats}`
          : "No context data yet for current engine.";
        await ctx.reply(msg, wetStats ? { parse_mode: "HTML" } : undefined);
        return;
      }

      // Codex input_tokens is billing sum (all API calls in turn), NOT context fill.
      // Show it as billing metric, not as context percentage.
      const lines = [
        `Engine: ${session.engine}`,
        `Session: ${session.sessionId}`,
        `Billing tokens (last turn): ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out`,
        `Cached: ${usage.cacheReadInputTokens.toLocaleString()} tokens`,
        `Context window: ${usage.contextWindow.toLocaleString()}`,
        `Context fill: N/A (Codex API does not expose true context usage)`,
        `Cost: $${session.totalCostUSD.toFixed(4)}`,
      ];

      if (wetStats) lines.push(wetStats);
      await ctx.reply(lines.join("\n"), wetStats ? { parse_mode: "HTML" } : undefined);
      return;
    }

    const usage = session.lastModelUsage ? Object.entries(session.lastModelUsage)[0] : null;
    if (!usage) {
      const msg = wetStats
        ? `No context data yet. Send a message first.${wetStats}`
        : "No context data yet. Send a message first.";
      await ctx.reply(msg, wetStats ? { parse_mode: "HTML" } : undefined);
      return;
    }

    const [model, u] = usage;
    const cost = session.totalCostUSD || 0;
    const shortId = session.sessionId!.slice(0, 8);

    // Resolve context source: wet proxy when available, dual-lane SDK+JSONL when disabled.
    let totalInput: number;
    let contextWindow: number;
    let source: string;

    if (WET_DISABLED) {
      // Dual-lane: prefer SDK snapshot, fall back to JSONL, then raw usage fields
      const st = getSessionTokens();
      const latest = st.getLatest();
      if (latest) {
        totalInput = latest.totalContext;
        contextWindow = st.getContextWindow();
        source = `(via SDK+JSONL, ${latest.source} lane)`;
      } else {
        totalInput = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
        contextWindow = u.contextWindow;
        source = "(via SDK result — no per-call data yet)";
      }
    } else {
      // Prefer wet proxy values stored on session (accurate, excludes subagent API calls).
      // Fall back to live wet query, then SDK values.
      const useSessionWet = session.wetContextWindow > 0 && session.wetContextTokens > 0;
      if (useSessionWet) {
        totalInput = session.wetContextTokens;
        contextWindow = session.wetContextWindow;
        source = "(via wet proxy)";
      } else {
        const wetStatus = await getWetStatus();
        const useWet = wetStatus !== null && wetStatus.context_window > 0;
        totalInput = useWet
          ? wetStatus.latest_total_input_tokens
          : u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
        contextWindow = useWet ? wetStatus.context_window : u.contextWindow;
        source = useWet ? "(via wet proxy)" : "(via SDK — may include subagent tokens)";
      }
    }

    const pct = contextWindow > 0 ? (totalInput / contextWindow) * 100 : 0;
    const remaining = contextWindow - totalInput;

    const lines = [
      `Session: ${shortId}`,
      `Model: ${model}`,
      `Context: ${totalInput.toLocaleString()} / ${contextWindow.toLocaleString()} (${pct.toFixed(1)}%) ${source}`,
      `Remaining: ${remaining.toLocaleString()} tokens`,
      `Cache: ${u.cacheReadInputTokens.toLocaleString()} read / ${u.cacheCreationInputTokens.toLocaleString()} created`,
      `Cost: $${cost.toFixed(4)}`,
    ];

    // When dual-lane is active, show both lane values for transparency
    if (WET_DISABLED) {
      const { sdk, jsonl } = getSessionTokens().getBothLanes();
      if (sdk && jsonl) {
        const divergence = getSessionTokens().checkDivergence();
        const divTag = divergence?.divergent ? " ⚠️ DIVERGENT" : "";
        lines.push(`SDK lane: ${sdk.totalContext.toLocaleString()} | JSONL lane: ${jsonl.totalContext.toLocaleString()}${divTag}`);
      } else if (sdk) {
        lines.push(`SDK lane: ${sdk.totalContext.toLocaleString()} | JSONL lane: no data`);
      } else if (jsonl) {
        lines.push(`SDK lane: no data | JSONL lane: ${jsonl.totalContext.toLocaleString()}`);
      }
    }

    if (wetStats) lines.push(wetStats);
    await ctx.reply(lines.join("\n"), wetStats ? { parse_mode: "HTML" } : undefined);
  });

  bot.command("mode", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = deps.store.get(userId);
    await ctx.reply(`Current mode: ${modeLabel(session.voiceMode)}\n\nSwitch mode:`, {
      reply_markup: modeKeyboard(),
    });
  });

  bot.command("voice", async (ctx) => {
    const userId = ctx.from?.id;
    const text = (ctx.message as { text?: string } | undefined)?.text;
    if (!userId || !text) return;

    const session = deps.store.get(userId);
    const voiceId = parseCommandArg(text, "voice");

    if (!voiceId) {
      await ctx.reply(`Current voice: ${session.voiceId}`);
      return;
    }

    session.voiceId = voiceId;
    deps.store.set(userId, session);
    await deps.store.save();

    await ctx.reply(`Voice switched to: ${voiceId}`);
  });

  bot.command("batch", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = deps.store.get(userId);

    if (session.batchDelayMs === 15_000) {
      session.batchDelayMs = 120_000;
      await ctx.reply("🐌 Long batch mode: 2 minutes. Send /batch again to switch back.");
    } else {
      session.batchDelayMs = 15_000;
      await ctx.reply("⚡ Quick batch mode: 15 seconds. Send /batch again to switch to long mode.");
    }

    deps.store.set(userId, session);
    await deps.store.save();
  });

  bot.command("engine", async (ctx) => {
    const userId = ctx.from?.id;
    const text = (ctx.message as { text?: string } | undefined)?.text;
    if (!userId || !text) return;

    const session = deps.store.get(userId);
    const arg = parseCommandArg(text, "engine").toLowerCase();

    if (!arg) {
      await ctx.reply(`Current engine: ${session.engine}`);
      return;
    }

    if (arg !== "claude" && arg !== "codex") {
      await ctx.reply("Usage: /engine [claude|codex]");
      return;
    }

    if (session.engine === arg) {
      await ctx.reply(`Already using ${arg}.`);
      return;
    }

    if (session.isQueryActive || session.abortController) {
      await abortUserQuery(userId, getAdapter(deps.engines, session.engine), deps.store, true);
    }

    // Dispose Claude streaming runtime on engine switch
    const oldAdapter = getAdapter(deps.engines, session.engine);
    if (oldAdapter.disposeSession) {
      await oldAdapter.disposeSession(String(userId));
    }

    await bufferManager.clearUserBuffers(userId);

    session.engine = arg;
    resetQueryState(session);

    deps.store.set(userId, session);
    await deps.store.save();

    await ctx.reply(
      `Engine switched to ${arg}. New ${arg} session will start on your next message.`
    );
  });

  bot.command("model", async (ctx) => {
    const userId = ctx.from?.id;
    const text = (ctx.message as { text?: string } | undefined)?.text;
    if (!userId || !text) return;

    const session = deps.store.get(userId);
    const arg = parseCommandArg(text, "model").toLowerCase();

    if (!arg) {
      await ctx.reply(`Current Codex model: ${session.codexModel}\nUsage: /model [${CODEX_MODELS.join("|")}]`);
      return;
    }

    if (!isCodexModel(arg)) {
      await ctx.reply(`Invalid Codex model. Choose: ${CODEX_MODELS.join(", ")}`);
      return;
    }

    if (session.codexModel === arg) {
      await ctx.reply(`Already using Codex model ${arg}.`);
      return;
    }

    if (session.engine === "codex" && (session.isQueryActive || session.abortController)) {
      await abortUserQuery(userId, getAdapter(deps.engines, session.engine), deps.store, true);
    }

    session.codexModel = arg;

    if (session.engine === "codex") {
      resetQueryState(session);
    }

    deps.store.set(userId, session);
    await deps.store.save();

    await ctx.reply(
      session.engine === "codex"
        ? `Codex model switched to ${arg}. A new Codex session will start on your next message.`
        : `Codex model set to ${arg}. It will be used the next time you switch to Codex.`
    );
  });

  bot.command("effort", async (ctx) => {
    const userId = ctx.from?.id;
    const text = (ctx.message as { text?: string } | undefined)?.text;
    if (!userId || !text) return;

    const session = deps.store.get(userId);
    const arg = parseCommandArg(text, "effort").toLowerCase();

    if (!arg) {
      await ctx.reply(`Current effort: ${displayEffort(session.reasoningEffort)}\nUsage: /effort [${REASONING_EFFORTS.join("|")}]`);
      return;
    }

    if (!isReasoningEffort(arg)) {
      await ctx.reply(`Invalid effort. Choose: ${REASONING_EFFORTS.join(", ")}`);
      return;
    }

    session.reasoningEffort = arg;
    deps.store.set(userId, session);
    await deps.store.save();

    await ctx.reply(`Reasoning effort set to: ${arg}`);
  });

  bot.command("thinking", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = deps.store.get(userId);
    session.showThinking = !session.showThinking;
    deps.store.set(userId, session);
    await deps.store.save();

    await ctx.reply(session.showThinking ? "Thinking visible. Send /thinking again to hide." : "Thinking hidden.");
  });

  bot.on("callback_query:data", async (ctx) => {
    try {
      await handleCallbackQuery(ctx, {
        bot,
        store: deps.store,
        bufferManager,
        engines: deps.engines,
      });
    } catch (error) {
      console.error("Callback handling error:", error);
    }
  });

  bot.on("message:voice", async (ctx) => {
    await handleVoiceMessage(ctx, {
      bot,
      store: deps.store,
      bufferManager,
      getAdapter: (engine) => getAdapter(deps.engines, engine),
      workingDir: deps.workingDir,
      ttsConfig: deps.ttsConfig,
      openaiClient: deps.openaiClient,
    });
  });

  bot.on("message:photo", async (ctx) => {
    await handlePhotoMessage(ctx, {
      bot,
      store: deps.store,
      bufferManager,
      mediaGroupCollector,
    });
  });

  bot.on("message:document", async (ctx) => {
    await handleDocumentMessage(ctx, {
      bot,
      store: deps.store,
      bufferManager,
      documentFilesDir: deps.documentFilesDir,
    });
  });

  bot.on("message:text", async (ctx) => {
    await handleTextMessage(ctx, {
      bot,
      store: deps.store,
      bufferManager,
      getAdapter: (engine) => getAdapter(deps.engines, engine),
      workingDir: deps.workingDir,
      ttsConfig: deps.ttsConfig,
    });
  });

  // Idle cleanup for Claude persistent runtimes — check every 60s
  const idleCleanupInterval = setInterval(async () => {
    const claudeAdapter = deps.engines.claude;
    if (claudeAdapter.disposeIdleSessions) {
      try {
        await claudeAdapter.disposeIdleSessions();
      } catch (error) {
        console.warn("[idle-cleanup] failed:", error);
      }
    }
  }, 60_000);

  // Ensure cleanup interval doesn't prevent process exit
  if (idleCleanupInterval.unref) {
    idleCleanupInterval.unref();
  }

  return {
    bot,
    bufferManager,
    mediaGroupCollector,
  };
}
