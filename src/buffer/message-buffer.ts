import { type Bot } from "grammy";

import { type EngineAdapter } from "../engine/interface";
import { processQuery } from "../handlers/query";
import { SessionStore } from "../session/store";
import { type ImageData, type MessageBuffer, type Session } from "../types";
import { wrapMessage, type WrapMessageMeta } from "../util/telegram";
import { type TTSRouterConfig } from "../voice/tts-router";
import { type MediaGroupCollector } from "./media-group";

export interface BufferManagerDeps {
  bot: Bot;
  store: SessionStore;
  getAdapter: (engine: Session["engine"]) => EngineAdapter;
  workingDir: string;
  ttsConfig: TTSRouterConfig;
}

export class BufferManager {
  private readonly messageBuffers = new Map<number, MessageBuffer>();
  private mediaGroupCollector?: MediaGroupCollector;

  constructor(private readonly deps: BufferManagerDeps) {}

  setMediaGroupCollector(mediaGroupCollector: MediaGroupCollector): void {
    this.mediaGroupCollector = mediaGroupCollector;
  }

  has(userId: number): boolean {
    const buffer = this.messageBuffers.get(userId);
    return Boolean(buffer && buffer.messages.length > 0);
  }

  bufferMessage(userId: number, chatId: number, message: MessageBuffer["messages"][number], session: Session): void {
    let buffer = this.messageBuffers.get(userId);
    if (!buffer) {
      buffer = { messages: [], timeout: null, chatId, userId };
      this.messageBuffers.set(userId, buffer);
    }

    buffer.messages.push(message);

    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }

    buffer.timeout = setTimeout(() => {
      void this.flushBuffer(userId);
    }, session.batchDelayMs);

    console.log(
      `Buffered message for user ${userId}, ${buffer.messages.length} pending, flushing in ${
        session.batchDelayMs / 1000
      }s`
    );
  }

  async clearUserBuffers(userId: number): Promise<void> {
    const buffer = this.messageBuffers.get(userId);
    if (buffer) {
      if (buffer.timeout) {
        clearTimeout(buffer.timeout);
      }

      for (const message of buffer.messages) {
        try {
          await this.deps.bot.api.deleteMessage(buffer.chatId, message.statusMsgId);
        } catch {
          // ignore status cleanup failures
        }
      }

      this.messageBuffers.delete(userId);
    }

    this.mediaGroupCollector?.clearUserGroups(userId);
  }

  async flushBuffer(userId: number): Promise<void> {
    const buffer = this.messageBuffers.get(userId);
    if (!buffer || buffer.messages.length === 0) {
      return;
    }

    const messages = [...buffer.messages];
    const chatId = buffer.chatId;
    this.messageBuffers.delete(userId);

    const wrappedParts: string[] = [];
    for (const msg of messages) {
      const meta: WrapMessageMeta = {
        username: msg.username,
        timestamp: new Date(msg.timestamps.telegramDateUnix * 1000).toISOString(),
        mediaType: msg.type === "text" ? undefined : (msg.type as "voice" | "photo" | "document"),
        isForwarded: msg.forward?.isForwarded,
        forwardOrigin: msg.forward?.forwardOrigin,
        replyToText: msg.reply?.replyToText,
      };
      wrappedParts.push(wrapMessage(msg.text, msg.voiceMode, meta));
    }

    const combinedText = wrappedParts.join("\n\n");

    const allImages: ImageData[] = [];
    for (const message of messages) {
      if (message.images) {
        allImages.push(...message.images);
      }
    }

    const lastStatusMsgId = messages[messages.length - 1]?.statusMsgId;

    for (let index = 0; index < messages.length - 1; index += 1) {
      const message = messages[index];
      if (!message) continue;

      try {
        await this.deps.bot.api.deleteMessage(chatId, message.statusMsgId);
      } catch {
        // ignore stale message ids
      }
    }

    if (lastStatusMsgId) {
      try {
        await this.deps.bot.api.editMessageText(chatId, lastStatusMsgId, "⏳ Processing...");
      } catch {
        // ignore status edit failures
      }
    }

    const session = this.deps.store.get(userId);
    const adapter = this.deps.getAdapter(session.engine);

    await processQuery({
      adapter,
      session,
      prompt: combinedText,
      userId,
      chatId,
      bot: this.deps.bot,
      store: this.deps.store,
      workingDir: this.deps.workingDir,
      ttsConfig: this.deps.ttsConfig,
      statusMsgId: lastStatusMsgId,
      images: allImages.length > 0 ? allImages : undefined,
    });
  }

  async clearAll(): Promise<void> {
    for (const [userId, buffer] of this.messageBuffers.entries()) {
      if (buffer.timeout) {
        clearTimeout(buffer.timeout);
      }

      for (const message of buffer.messages) {
        try {
          await this.deps.bot.api.deleteMessage(buffer.chatId, message.statusMsgId);
        } catch {
          // ignore status cleanup failures
        }
      }

      console.log(`Clearing ${buffer.messages.length} buffered messages for user ${userId}`);
    }

    this.messageBuffers.clear();
    this.mediaGroupCollector?.clearAll();
  }
}
