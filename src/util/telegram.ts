import { type Bot } from "grammy";

import { BOT_TOKEN } from "../config";
import { type VoiceMode } from "../types";

type TelegramParseMode = "HTML" | "Markdown" | "MarkdownV2";

export function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mimeTypes[ext] || "image/jpeg";
}

export async function downloadTelegramFile(
  bot: Bot,
  fileId: string
): Promise<{ buffer: Buffer; filename: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram file path is missing for fileId: ${fileId}`);
  }

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with status ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = file.file_path.split("/").pop() || "image.jpg";
  return { buffer, filename };
}

export interface WrapMessageMeta {
  username?: string;
  timestamp?: string;
  mediaType?: "voice" | "photo" | "document";
  isForwarded?: boolean;
  forwardOrigin?: string;
  replyToText?: string;
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlContent(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function wrapMessage(
  message: string,
  voiceMode: VoiceMode,
  meta?: WrapMessageMeta
): string {
  const tag = meta?.mediaType === "voice" ? "tg_message_voice" : "tg_message";

  const attrs: string[] = [];
  if (meta?.username) attrs.push(`from="${escapeXmlAttr(meta.username)}"`);
  if (meta?.timestamp) attrs.push(`ts="${escapeXmlAttr(meta.timestamp)}"`);
  if (meta?.mediaType) attrs.push(`media="${meta.mediaType}"`);
  if (meta?.isForwarded) attrs.push(`forwarded="true"`);
  if (meta?.forwardOrigin)
    attrs.push(`forward_from="${escapeXmlAttr(meta.forwardOrigin)}"`);

  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";

  let inner = "";
  if (meta?.replyToText) {
    inner += `<reply_to>${escapeXmlContent(meta.replyToText)}</reply_to>\n`;
  }
  inner += message;

  return `<${tag}${attrStr}>\n${inner}\n</${tag}>`;
}

export function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function sendLongMessageDirect(
  bot: Bot,
  chatId: number,
  text: string,
  maxLen = 4000,
  parseMode?: TelegramParseMode
): Promise<void> {
  const opts = parseMode ? { parse_mode: parseMode } : undefined;
  const messageText = parseMode ? text : stripHtmlTags(text);

  if (messageText.length <= maxLen) {
    try {
      await bot.api.sendMessage(chatId, messageText, opts);
    } catch {
      await bot.api.sendMessage(chatId, stripHtmlTags(messageText));
    }
    return;
  }

  let remaining = messageText;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      try {
        await bot.api.sendMessage(chatId, remaining, opts);
      } catch {
        await bot.api.sendMessage(chatId, stripHtmlTags(remaining));
      }
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    // Don't split inside an HTML tag: find last '>' before splitAt,
    // then check if there's an unmatched '<' after it.
    const lastClose = remaining.lastIndexOf(">", splitAt);
    const lastOpen = remaining.lastIndexOf("<", splitAt);
    if (lastOpen > lastClose) {
      // We're inside a tag — back up to before the '<'
      splitAt = lastOpen;
      if (splitAt <= 0) splitAt = maxLen; // safety fallback
    }

    const chunk = remaining.slice(0, splitAt);
    try {
      await bot.api.sendMessage(chatId, chunk, opts);
    } catch {
      await bot.api.sendMessage(chatId, stripHtmlTags(chunk));
    }
    remaining = remaining.slice(splitAt).trim();
  }
}
