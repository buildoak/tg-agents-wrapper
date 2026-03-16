import { existsSync } from "fs";

import { type Bot, InputFile } from "grammy";

export const SEND_FILE_PATTERN = /\[SEND_FILE:([^\]]+)\]/g;

export interface SendFilesResult {
  cleanedText: string;
  fileNotifications: string[];
}

export async function sendFilesToUser(
  bot: Bot,
  chatId: number,
  text: string
): Promise<SendFilesResult> {
  const matches = [...text.matchAll(SEND_FILE_PATTERN)];
  let cleanedText = text;
  const fileNotifications: string[] = [];

  for (const match of matches) {
    const rawPath = match[1];
    if (!rawPath) continue;

    const filePath = rawPath.trim();
    try {
      if (existsSync(filePath)) {
        const filename = filePath.split("/").pop() || "file";
        await bot.api.sendDocument(chatId, new InputFile(filePath, filename));
        const notification = `📎 Sent: ${filename}`;
        cleanedText = cleanedText.replace(match[0], notification);
        fileNotifications.push(notification);
      } else {
        const notification = `❌ File not found: ${filePath}`;
        cleanedText = cleanedText.replace(match[0], notification);
        fileNotifications.push(notification);
      }
    } catch (error) {
      console.error("File send error:", error);
      const notification = `❌ Failed to send: ${filePath}`;
      cleanedText = cleanedText.replace(match[0], notification);
      fileNotifications.push(notification);
    }
  }

  return { cleanedText, fileNotifications };
}
