import { type Bot, type Context } from "grammy";

import { BufferManager } from "../buffer/message-buffer";
import { type EngineAdapter } from "../engine/interface";
import { processQuery, type ProcessQueryOptions } from "./query";
import { abortUserQuery } from "../session/lifecycle";
import { SessionStore } from "../session/store";
import { type Session } from "../types";
import { wrapMessage, type WrapMessageMeta } from "../util/telegram";
import { extractMessageMeta } from "../util/message-meta";
import { type TTSRouterConfig } from "../voice/tts-router";

export interface TextHandlerDeps {
  bot: Bot;
  store: SessionStore;
  bufferManager: BufferManager;
  getAdapter: (engine: Session["engine"]) => EngineAdapter;
  workingDir: string;
  ttsConfig: TTSRouterConfig;
}

function buildQueryOptions(
  deps: TextHandlerDeps,
  session: Session,
  userId: number,
  chatId: number,
  prompt: string,
  statusMsgId?: number
): ProcessQueryOptions {
  return {
    adapter: deps.getAdapter(session.engine),
    session,
    prompt,
    userId,
    chatId,
    bot: deps.bot,
    store: deps.store,
    workingDir: deps.workingDir,
    ttsConfig: deps.ttsConfig,
    statusMsgId,
  };
}

export async function handleTextMessage(ctx: Context, deps: TextHandlerDeps): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const text = (ctx.message as { text?: string } | undefined)?.text;

  if (!userId || !chatId || typeof text !== "string") {
    return;
  }

  const session = deps.store.get(userId);
  session.chatId = chatId;

  if (session.isResetting) {
    await ctx.reply("Please wait, session is being reset...");
    return;
  }

  let prompt = text;
  const isInterrupt = prompt.startsWith("!");

  const meta = extractMessageMeta(ctx);
  if (!meta) return;

  if (isInterrupt) {
    prompt = prompt.slice(1).trim();

    await abortUserQuery(userId, deps.getAdapter(session.engine), deps.store, true);
    await deps.bufferManager.clearUserBuffers(userId);

    const wrapMeta: WrapMessageMeta = {
      username: meta.username,
      timestamp: new Date(meta.date * 1000).toISOString(),
      isForwarded: meta.forward?.isForwarded,
      forwardOrigin: meta.forward?.forwardOrigin,
      replyToText: meta.reply?.replyToText,
    };
    const wrappedMessage = wrapMessage(prompt, session.voiceMode, wrapMeta);
    const statusMsg = await ctx.reply("⏳ Processing...");

    await processQuery(
      buildQueryOptions(deps, session, userId, chatId, wrappedMessage, statusMsg.message_id)
    );
    return;
  }

  const statusMsg = await ctx.reply("📨 Queued...");

  deps.bufferManager.bufferMessage(
    userId,
    chatId,
    {
      telegramMessageId: meta.messageId,
      userId,
      chatId,
      username: meta.username,
      text: prompt,
      type: "text",
      reply: meta.reply,
      media: meta.media,
      forward: meta.forward,
      timestamps: { telegramDateUnix: meta.date, receivedAtUnix: Date.now() },
      voiceMode: session.voiceMode,
      statusMsgId: statusMsg.message_id,
    },
    session
  );
}
