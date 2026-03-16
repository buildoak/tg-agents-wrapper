import { type Context } from "grammy";
import {
  type InboundReplyContext,
  type InboundForwardInfo,
  type InboundMediaFlags,
} from "../bus/bus";

export interface TelegramMessageMeta {
  messageId: number;
  userId: number;
  chatId: number;
  username?: string;
  date: number;
  text?: string;
  caption?: string;
  reply?: InboundReplyContext;
  forward?: InboundForwardInfo;
  media: InboundMediaFlags;
}

export function extractMessageMeta(ctx: Context): TelegramMessageMeta | null {
  const msg = ctx.message;
  if (!msg || !ctx.from?.id || !ctx.chat?.id) return null;

  const reply: InboundReplyContext | undefined = msg.reply_to_message
    ? {
        replyToMessageId: msg.reply_to_message.message_id,
        replyToText: truncateReplyText(
          (msg.reply_to_message as any).text as string ||
          (msg.reply_to_message as any).caption as string ||
          ""
        ),
      }
    : undefined;

  const forward: InboundForwardInfo | undefined = (() => {
    const origin = (msg as any).forward_origin as
      | { type: string; chat?: { title?: string; username?: string }; sender_user?: { first_name?: string; last_name?: string }; sender_user_name?: string }
      | undefined;
    if (!origin) return undefined;
    const type = origin.type;
    if (type === "channel") {
      const title = origin.chat?.title || "unknown channel";
      const username = origin.chat?.username;
      return {
        isForwarded: true,
        forwardOrigin: username ? `channel: @${username}` : `channel: ${title}`,
      };
    }
    if (type === "user") {
      const name =
        [origin.sender_user?.first_name, origin.sender_user?.last_name]
          .filter(Boolean)
          .join(" ") || "unknown";
      return { isForwarded: true, forwardOrigin: `user: ${name}` };
    }
    if (type === "hidden_user") {
      return {
        isForwarded: true,
        forwardOrigin: `user: ${origin.sender_user_name || "hidden"}`,
      };
    }
    return { isForwarded: true, forwardOrigin: "unknown" };
  })();

  const media: InboundMediaFlags = {
    hasVoice: Boolean((msg as any).voice),
    hasPhoto: Boolean((msg as any).photo),
    hasDocument: Boolean((msg as any).document),
    hasMediaGroup: Boolean((msg as any).media_group_id),
  };

  const replyWithText =
    reply && reply.replyToText ? reply : undefined;

  return {
    messageId: msg.message_id,
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    username: ctx.from.username || ctx.from.first_name,
    date: msg.date,
    text: (msg as any).text as string | undefined,
    caption: (msg as any).caption as string | undefined,
    reply: replyWithText,
    forward,
    media,
  };
}

function truncateReplyText(text: string, max = 200): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}
