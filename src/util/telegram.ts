import { type Bot, type Context } from "grammy";

import { BOT_TOKEN } from "../config";
import { type VoiceMode } from "../types";

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
  const tag = voiceMode !== "off" ? "tg_message_voice" : "tg_message";

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

export async function sendLongMessage(
  _bot: Bot,
  ctx: Context,
  text: string,
  maxLen = 4000,
  parseMode?: string
): Promise<void> {
  const opts = parseMode ? { parse_mode: parseMode } : undefined;

  if (text.length <= maxLen) {
    await ctx.reply(text, opts as any);
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      await ctx.reply(remaining, opts as any);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    await ctx.reply(remaining.slice(0, splitAt), opts as any);
    remaining = remaining.slice(splitAt).trim();
  }
}

export async function sendLongMessageDirect(
  bot: Bot,
  chatId: number,
  text: string,
  maxLen = 4000,
  parseMode?: string
): Promise<void> {
  const opts = parseMode ? { parse_mode: parseMode } : undefined;

  if (text.length <= maxLen) {
    await bot.api.sendMessage(chatId, text, opts as any);
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      await bot.api.sendMessage(chatId, remaining, opts as any);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    await bot.api.sendMessage(chatId, remaining.slice(0, splitAt), opts as any);
    remaining = remaining.slice(splitAt).trim();
  }
}
