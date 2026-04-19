import { type Bot, type Context } from "grammy";

import { BufferManager } from "../buffer/message-buffer";
import { abortUserQuery, resetSession } from "../session/lifecycle";
import { SessionStore } from "../session/store";
import { type EngineType } from "../types";
import { type EngineAdapter } from "../engine/interface";

export interface CallbackHandlerDeps {
  bot: Bot;
  store: SessionStore;
  bufferManager: BufferManager;
  engines: Record<EngineType, EngineAdapter>;
}

function isEngineType(value: string): value is EngineType {
  return value === "claude" || value === "codex";
}

export async function handleCallbackQuery(ctx: Context, deps: CallbackHandlerDeps): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return;
  }

  if (data.startsWith("reset:")) {
    const rawUserId = data.split(":")[1];
    const targetUserId = rawUserId ? Number.parseInt(rawUserId, 10) : Number.NaN;

    if (Number.isNaN(targetUserId)) {
      await ctx.answerCallbackQuery({ text: "Invalid reset target" });
      return;
    }

    const targetSession = deps.store.getAll().get(targetUserId);
    const resetEngine = targetSession
      ? deps.engines[targetSession.engine]
      : "claude";

    await ctx.answerCallbackQuery({ text: "Resetting session..." });

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    await resetSession(targetUserId, resetEngine, deps.store, chatId, deps.bot);
    return;
  }

  const separator = data.indexOf(":");
  if (separator < 0) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const action = data.slice(0, separator);
  const value = data.slice(separator + 1);

  if (action === "mode") {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = deps.store.get(userId);

    if (value === "normal") {
      session.voiceMode = "off";
    } else if (value === "cloud" || value === "local") {
      session.voiceMode = value;
    } else {
      await ctx.answerCallbackQuery({ text: "Invalid mode" });
      return;
    }

    deps.store.set(userId, session);
    await deps.store.save();

    const modeLabel =
      session.voiceMode === "cloud"
        ? "🎙️ Voice (Cloud)"
        : session.voiceMode === "local"
          ? "🖥️ Voice Local"
          : "📝 Normal";

    await ctx.answerCallbackQuery({ text: `${modeLabel} mode activated` });
    try {
      await ctx.editMessageText(`${modeLabel} mode activated.`);
    } catch {
      // ignore if message can no longer be edited
    }
    return;
  }

  if (action === "engine") {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!isEngineType(value)) {
      await ctx.answerCallbackQuery({ text: "Invalid engine" });
      return;
    }

    const session = deps.store.get(userId);
    if (session.engine === value) {
      await ctx.answerCallbackQuery({ text: `Already using ${value}` });
      return;
    }

    if (session.isQueryActive || session.abortController) {
      await abortUserQuery(userId, deps.engines[session.engine], deps.store, true);
    }

    // Dispose Claude streaming runtime on engine switch
    const oldAdapter = deps.engines[session.engine];
    if (oldAdapter.disposeSession) {
      try {
        await oldAdapter.disposeSession(String(userId));
      } catch (error) {
        console.warn(`[callback] dispose runtime failed for user ${userId}:`, error);
      }
    }

    await deps.bufferManager.clearUserBuffers(userId);

    session.engine = value;
    session.sessionId = undefined;
    session.lastInputTokens = 0;
    session.cumulativeInputTokens = 0;
    session.lastModelUsage = undefined;

    deps.store.set(userId, session);
    await deps.store.save();

    await ctx.answerCallbackQuery({ text: `Switched to ${value}` });
    try {
      await ctx.editMessageText(`Engine switched to ${value}.`);
    } catch {
      // ignore if message can no longer be edited
    }
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unsupported callback" });
}
