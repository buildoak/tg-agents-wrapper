import { type Bot, type Context } from "grammy";

import { BufferManager } from "../buffer/message-buffer";
import { SessionStore } from "../session/store";
import { cleanupOldFiles } from "../util/cleanup";
import { downloadTelegramFile } from "../util/telegram";
import { extractMessageMeta } from "../util/message-meta";

let lastCleanupTime = 0;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface DocumentHandlerDeps {
  bot: Bot;
  store: SessionStore;
  bufferManager: BufferManager;
  documentFilesDir: string;
}

export async function handleDocumentMessage(ctx: Context, deps: DocumentHandlerDeps): Promise<void> {
  if (Date.now() - lastCleanupTime > CLEANUP_INTERVAL_MS) {
    lastCleanupTime = Date.now();
    cleanupOldFiles(deps.documentFilesDir);
  }

  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const message = ctx.message as {
    document?: { file_id: string; file_name?: string };
    caption?: string;
  } | undefined;
  const document = message?.document;

  if (!userId || !chatId || !document) {
    return;
  }

  const session = deps.store.get(userId);
  session.chatId = chatId;

  const statusMsg = await ctx.reply("📎 Saving file...");

  try {
    const { buffer, filename } = await downloadTelegramFile(deps.bot, document.file_id);
    const baseName = (document.file_name || filename || "file").replace(/[\\/]/g, "_");
    const savedName = `${new Date().toISOString().slice(0, 10)}-${Date.now()}-${baseName}`;
    const savedPath = `${deps.documentFilesDir}/${savedName}`;

    await Bun.write(savedPath, buffer);

    const caption = message?.caption?.trim();
    const prompt = `User sent a file: ${savedName} saved at ${savedPath}. Read and analyze it.${
      caption ? `\n\nUser caption: ${caption}` : ""
    }`;

    const meta = extractMessageMeta(ctx);
    if (!meta) return;

    try {
      await deps.bot.api.editMessageText(chatId, statusMsg.message_id, "📨 Queued...");
    } catch {
      // ignore edit failures
    }

    deps.bufferManager.bufferMessage(
      userId,
      chatId,
      {
        telegramMessageId: meta.messageId,
        userId,
        chatId,
        username: meta.username,
        text: prompt,
        type: "document",
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
    console.error("Document handling error:", error);
    await ctx.reply(`❌ Error processing file: ${String(error).slice(0, 200)}`);
  }
}
