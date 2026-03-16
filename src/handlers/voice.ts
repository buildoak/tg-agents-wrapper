import { unlinkSync } from "fs";

import { type Bot, type Context } from "grammy";

import { BufferManager } from "../buffer/message-buffer";
import { TEMP_DIR } from "../config";
import { type EngineAdapter } from "../engine/interface";
import { processQuery } from "./query";
import { abortUserQuery } from "../session/lifecycle";
import { SessionStore } from "../session/store";
import { type Session } from "../types";
import { downloadTelegramFile, wrapMessage, type WrapMessageMeta } from "../util/telegram";
import { extractMessageMeta } from "../util/message-meta";
import { transcribeVoice, type OpenAITranscriptionClient } from "../voice/transcribe";
import { type TTSRouterConfig } from "../voice/tts-router";

export interface VoiceHandlerDeps {
  bot: Bot;
  store: SessionStore;
  bufferManager: BufferManager;
  getAdapter: (engine: Session["engine"]) => EngineAdapter;
  workingDir: string;
  ttsConfig: TTSRouterConfig;
  openaiClient?: OpenAITranscriptionClient | null;
}

export async function handleVoiceMessage(ctx: Context, deps: VoiceHandlerDeps): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const message = ctx.message as { voice?: { file_id?: string } } | undefined;
  const voiceId = message?.voice?.file_id;

  if (!userId || !chatId || !voiceId) {
    return;
  }

  const session = deps.store.get(userId);
  session.chatId = chatId;

  if (!deps.openaiClient) {
    await ctx.reply("Voice transcription not configured. Set OPENAI_API_KEY.");
    return;
  }

  const statusMsg = await ctx.reply("🎤 Transcribing...");
  let voicePath: string | null = null;

  try {
    const { buffer, filename } = await downloadTelegramFile(deps.bot, voiceId);
    const extension = filename.split(".").pop() || "ogg";
    voicePath = `${TEMP_DIR}/voice_${Date.now()}_${userId}.${extension}`;
    await Bun.write(voicePath, buffer);

    const transcript = await transcribeVoice(voicePath, deps.openaiClient);
    if (!transcript) {
      await deps.bot.api.editMessageText(chatId, statusMsg.message_id, "❌ Transcription failed.");
      return;
    }

    await deps.bot.api.editMessageText(chatId, statusMsg.message_id, `🎤 You said:\n"${transcript}"`);

    const meta = extractMessageMeta(ctx);
    if (!meta) return;

    const isInterrupt = transcript.startsWith("!");
    const voiceText = isInterrupt ? transcript.slice(1).trim() : transcript;

    if (isInterrupt) {
      await abortUserQuery(userId, deps.getAdapter(session.engine), deps.store, true);
      await deps.bufferManager.clearUserBuffers(userId);

      const wrapMeta: WrapMessageMeta = {
        username: meta.username,
        timestamp: new Date(meta.date * 1000).toISOString(),
        mediaType: "voice",
        isForwarded: meta.forward?.isForwarded,
        forwardOrigin: meta.forward?.forwardOrigin,
        replyToText: meta.reply?.replyToText,
      };
      const wrappedMessage = wrapMessage(voiceText, session.voiceMode, wrapMeta);
      const processingStatus = await ctx.reply("⏳ Processing...");

      await processQuery({
        adapter: deps.getAdapter(session.engine),
        session,
        prompt: wrappedMessage,
        userId,
        chatId,
        bot: deps.bot,
        store: deps.store,
        workingDir: deps.workingDir,
        ttsConfig: deps.ttsConfig,
        statusMsgId: processingStatus.message_id,
      });
      return;
    }

    const queuedStatus = await ctx.reply("📨 Queued...");

    deps.bufferManager.bufferMessage(
      userId,
      chatId,
      {
        telegramMessageId: meta.messageId,
        userId,
        chatId,
        username: meta.username,
        text: voiceText,
        type: "voice",
        reply: meta.reply,
        media: meta.media,
        forward: meta.forward,
        timestamps: { telegramDateUnix: meta.date, receivedAtUnix: Date.now() },
        voiceMode: session.voiceMode,
        statusMsgId: queuedStatus.message_id,
      },
      session
    );
  } catch (error) {
    console.error("Voice handling error:", error);
    await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
  } finally {
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch {
        // ignore cleanup failures
      }
    }
  }
}
