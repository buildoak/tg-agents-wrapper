import type { VoiceMode } from "../types";
import { type ElevenLabsConfig, textToSpeech } from "./tts-elevenlabs";
import { type KokoroConfig, kokoroTextToSpeech } from "./tts-kokoro";

export interface TTSRouterConfig {
  elevenLabs: ElevenLabsConfig;
  kokoro: KokoroConfig;
}

export async function synthesizeSpeech(
  text: string,
  voiceMode: VoiceMode,
  config: TTSRouterConfig
): Promise<Buffer[]> {
  if (voiceMode === "off") {
    return [];
  }

  if (voiceMode === "cloud") {
    return textToSpeech(text, config.elevenLabs);
  }

  if (voiceMode === "local") {
    return kokoroTextToSpeech(text, config.kokoro);
  }

  return [];
}
