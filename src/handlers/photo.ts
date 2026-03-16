import { type Bot, type Context } from "grammy";

import { BufferManager } from "../buffer/message-buffer";
import { MediaGroupCollector } from "../buffer/media-group";
import { SessionStore } from "../session/store";
import { getMimeType, downloadTelegramFile } from "../util/telegram";
import { extractMessageMeta } from "../util/message-meta";

export interface PhotoHandlerDeps {
  bot: Bot;
  store: SessionStore;
  bufferManager: BufferManager;
  mediaGroupCollector: MediaGroupCollector;
}

export async function handlePhotoMessage(ctx: Context, deps: PhotoHandlerDeps): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const message = ctx.message as {
    photo?: Array<{ file_id: string }>;
    caption?: string;
    media_group_id?: string;
  } | undefined;
  const photos = message?.photo;

  if (!userId || !chatId || !Array.isArray(photos) || photos.length === 0) {
    return;
  }

  const session = deps.store.get(userId);
  session.chatId = chatId;

  const largestPhoto = photos[photos.length - 1];
  if (!largestPhoto) {
    return;
  }

  try {
    const { buffer, filename } = await downloadTelegramFile(deps.bot, largestPhoto.file_id);
    const mimeType = getMimeType(filename);
    const imageData = { buffer, mimeType };

    const caption = message?.caption || "";
    const mediaGroupId = message?.media_group_id;

    if (mediaGroupId) {
      deps.mediaGroupCollector.collect(mediaGroupId, {
        image: imageData,
        caption,
        chatId,
        userId,
      });
      return;
    }

    const meta = extractMessageMeta(ctx);
    if (!meta) return;

    const statusMsg = await ctx.reply("📨 Queued...");
    const imagePrompt = caption || "What's in this image?";

    deps.bufferManager.bufferMessage(
      userId,
      chatId,
      {
        telegramMessageId: meta.messageId,
        userId,
        chatId,
        username: meta.username,
        text: imagePrompt,
        type: "photo",
        images: [imageData],
        reply: meta.reply,
        media: meta.media,
        forward: meta.forward,
        timestamps: { telegramDateUnix: meta.date, receivedAtUnix: Date.now() },
        voiceMode: session.voiceMode,
        statusMsgId: statusMsg.message_id,
      },
      session
    );
  } catch (error) {
    console.error("Photo handling error:", error);
    await ctx.reply(`❌ Error processing image: ${String(error).slice(0, 200)}`);
  }
}
