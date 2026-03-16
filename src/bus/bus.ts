import { type ImageData, type VoiceMode } from "../types";

export interface InboundReplyContext {
  replyToMessageId: number;
  replyToText: string;
}

export interface InboundMediaFlags {
  hasVoice: boolean;
  hasPhoto: boolean;
  hasDocument: boolean;
  hasMediaGroup: boolean;
}

export interface InboundTimestamps {
  telegramDateUnix: number;
  receivedAtUnix: number;
}

export interface InboundForwardInfo {
  isForwarded: boolean;
  forwardOrigin?: string;
}

export interface InboundMessage {
  telegramMessageId: number;
  userId: number;
  chatId: number;
  username?: string;
  text: string;
  type: "text" | "voice" | "photo" | "document";
  images?: ImageData[];
  reply?: InboundReplyContext;
  media: InboundMediaFlags;
  forward?: InboundForwardInfo;
  timestamps: InboundTimestamps;
  voiceMode: VoiceMode;
  statusMsgId: number;
}
